// summarize.mjs — AI Model Router (Netlify Function)
// Routes summarization/trend/article requests through a round-robin of Gemini models
// with Groq fallback. Includes 1-hour response cache, CORS headers, and multi-key rotation.

// ── Key Manager for multi-key Gemini API key rotation ──────────────
class KeyManager {
  constructor() {
    this.keys = (process.env.GEMINI_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
    this.keyStates = this.keys.map(() => ({
      cooldownUntil: 0,
      requestCount: 0,
      windowStart: Date.now()
    }));
    this.currentIndex = 0;
  }

  getAvailableKey() {
    if (this.keys.length === 0) return { key: null, index: -1 };
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length;
      const state = this.keyStates[idx];
      // Reset rate limit window if 1 min passed
      if (now - state.windowStart > 60000) {
        state.requestCount = 0;
        state.windowStart = now;
      }
      // Gemini Flash has 15 RPM limit on free tier. Let's cap at 14 per key to be safe.
      if (now >= state.cooldownUntil && state.requestCount < 14) {
        this.currentIndex = idx;
        return { key: this.keys[idx], index: idx };
      }
    }
    // If all keys are rate limited, return the current index (will either succeed or trigger 429)
    return { key: this.keys[this.currentIndex], index: this.currentIndex };
  }

  handle429(index) {
    if (index >= 0 && index < this.keyStates.length) {
      this.keyStates[index].cooldownUntil = Date.now() + 60000; // 60s cooldown
    }
  }

  incrementRequest(index) {
    if (index >= 0 && index < this.keyStates.length) {
      this.keyStates[index].requestCount++;
    }
  }
}

// Global instance (persists during container warm state)
const keyManager = new KeyManager();

// ── Model rotation pool ────────────────────────────────────────────
const MODELS = [
  { id: "gemini-2.5-flash",      provider: "gemini" },  // 0 — primary workhorse (15 RPM, 1500 RPD)
  { id: "gemini-2.5-flash-lite", provider: "gemini" },  // 1 — fast backup   (30 RPM, 1500 RPD)
  { id: "gemini-2.5-pro",        provider: "gemini" },  // 2 — premium       (5 RPM, 50 RPD — skip 90%)
  { id: "llama-3.3-70b-versatile", provider: "groq" },  // 3 — Groq fallback
  { id: "llama-3.1-8b-instant",    provider: "groq" },  // 4 — last resort
];

// Round-robin counter (persists across warm invocations)
let modelIndex = 0;
// Tracks total rotations so we can gate index-2 usage
let rotationCount = 0;

// ── Response cache (1-hour TTL) ────────────────────────────────────
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const responseCache = new Map();

// ── CORS headers applied to every response ─────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Prompt builders ────────────────────────────────────────────────

function buildPrompt(mode, title, url, content) {
  if (mode === "trends") {
    return `You are a tech trend analyst. Analyze these top tech headlines from today and identify 3-4 key trends or themes. Be specific, cite which headlines support each trend, and explain why developers should care.

Headlines:
${content}

Trend Analysis:`;
  }

  if (mode === "article") {
    return `You are a technical journalist writing for DevPulse, a premium developer publication. 
Write a high-quality, engaging, and original developer article based on the following news:
Title: ${title}
Source URL: ${url}
Context Summary: ${content || "Developer interest news."}

Your article must:
1. Be original, professional, and insightful (400-600 words). Do not copy source text directly; rewrite it from a developer's perspective.
2. Include sections:
   - A bold hook introduction (Why this matters)
   - Deep dive details (Technical mechanics/key concepts)
   - Developer Impact (Practical takeaways, how it changes tools/workflows)
   - Summary/Conclusion
3. Format beautifully in Markdown (use headers ##, bold texts, lists, and code blocks if applicable).
4. Do not include any meta comments, just output the markdown article.

Write the article:`;
  }

  // Default: summarize
  return `You are a concise tech news summarizer. Given the following article title and URL, provide a 2-3 sentence TL;DR summary that captures the key points. Be specific and informative, not generic.

Title: ${title}
URL: ${url}
${content ? `\n${content}\n` : ""}
TL;DR:`;
}

// ── API callers ────────────────────────────────────────────────────

/**
 * Call a Google Gemini model via the generateContent endpoint using the key manager's rotated key.
 * Returns { text, status }.
 */
async function callGemini(modelId, prompt, maxTokens = 250) {
  const { key: apiKey, index: keyIndex } = keyManager.getAvailableKey();
  if (!apiKey) throw new Error("No GEMINI_API_KEY is configured.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  keyManager.incrementRequest(keyIndex);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.3,
        },
      }),
    });

    if (res.status === 429) {
      keyManager.handle429(keyIndex);
      return { text: null, status: 429 };
    }

    if (!res.ok) {
      return { text: null, status: res.status };
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    return { text, status: res.status };
  } catch (err) {
    return { text: null, status: 500 };
  }
}

/**
 * Call a Groq model via the OpenAI-compatible chat completions endpoint.
 * Returns { text, status }.
 */
async function callGroq(modelId, prompt, maxTokens = 250) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      return { text: null, status: res.status };
    }

    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? null;
    return { text, status: res.status };
  } catch {
    return { text: null, status: 500 };
  }
}

// ── Model selection helpers ────────────────────────────────────────

/**
 * Decide whether to skip index 2 (gemini-2.5-pro).
 * Only allow it every 10th rotation to preserve the 50 RPD quota.
 */
function shouldSkipPro(idx) {
  if (idx !== 2) return false;
  return rotationCount % 10 !== 0; // allow on every 10th rotation
}

/**
 * Advance modelIndex to the next slot, skipping pro when necessary.
 */
function advanceIndex() {
  modelIndex = (modelIndex + 1) % MODELS.length;
  rotationCount++;

  // If we landed on pro and should skip, advance again
  if (shouldSkipPro(modelIndex)) {
    modelIndex = (modelIndex + 1) % MODELS.length;
  }
}

// ── Main handler ───────────────────────────────────────────────────

export default async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // ── Parse request body ──────────────────────────────────────────
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { title = "", url = "", content = "", mode = "summarize" } = body;

    if (mode === "summarize" && !title) {
      return new Response(
        JSON.stringify({ error: "Missing required field: title" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Check cache ─────────────────────────────────────────────────
    const cacheKey = mode === "trends" ? `${mode}:trends` : `${mode}:${title}`;
    const cached = responseCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return new Response(
        JSON.stringify({ summary: cached.summary, model: cached.model, cached: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Build prompt ────────────────────────────────────────────────
    const prompt = buildPrompt(mode, title, url, content);
    const maxTokens = mode === "article" ? 1500 : 250;

    // ── Try models in rotation order ────────────────────────────────
    let resultText = null;
    let usedModel = null;

    // Skip pro on initial pick if necessary
    if (shouldSkipPro(modelIndex)) {
      advanceIndex();
    }

    for (let attempts = 0; attempts < MODELS.length; attempts++) {
      const model = MODELS[modelIndex];

      try {
        const { text, status } =
          model.provider === "gemini"
            ? await callGemini(model.id, prompt, maxTokens)
            : await callGroq(model.id, prompt, maxTokens);

        if (status === 429 || text === null) {
          // Rate-limited or empty — try the next model
          advanceIndex();
          continue;
        }

        // Success
        resultText = text;
        usedModel = model.id;
        advanceIndex(); // rotate for next request
        break;
      } catch {
        // Network error or missing key — try next model
        advanceIndex();
        continue;
      }
    }

    if (!resultText) {
      return new Response(
        JSON.stringify({ error: "All AI models are currently unavailable. Please try again later." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Cache the result ────────────────────────────────────────────
    responseCache.set(cacheKey, {
      summary: resultText,
      model: usedModel,
      timestamp: Date.now(),
    });

    return new Response(
      JSON.stringify({ summary: resultText, model: usedModel, cached: false }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

// Netlify Functions v2 config
export const config = { path: "/api/summarize", method: "POST" };
export { keyManager };
