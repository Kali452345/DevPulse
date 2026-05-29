// generate-article.mjs — AI Article Generator & Saver (Netlify Function)
// Scrapes the source website for page details (OG image, description),
// triggers the AI generation model using multi-key Gemini rotation,
// and persists the result to Netlify Blobs storage.

import { getStore } from "@netlify/blobs";

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
      if (now - state.windowStart > 60000) {
        state.requestCount = 0;
        state.windowStart = now;
      }
      if (now >= state.cooldownUntil && state.requestCount < 14) {
        this.currentIndex = idx;
        return { key: this.keys[idx], index: idx };
      }
    }
    return { key: this.keys[this.currentIndex], index: this.currentIndex };
  }

  handle429(index) {
    if (index >= 0 && index < this.keyStates.length) {
      this.keyStates[index].cooldownUntil = Date.now() + 60000;
    }
  }

  incrementRequest(index) {
    if (index >= 0 && index < this.keyStates.length) {
      this.keyStates[index].requestCount++;
    }
  }
}

const keyManager = new KeyManager();

const MODELS = [
  { id: "gemini-2.5-flash",      provider: "gemini" },
  { id: "gemini-2.5-flash-lite", provider: "gemini" },
  { id: "gemini-2.5-pro",        provider: "gemini" },
  { id: "llama-3.3-70b-versatile", provider: "groq" },
  { id: "llama-3.1-8b-instant",    provider: "groq" },
];

let modelIndex = 0;
let rotationCount = 0;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Simple web scraper to extract cover image and description
async function scrapeMetadata(url) {
  const result = { coverImage: "", description: "" };
  if (!url || url === "#") return result;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3-second limit

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DevPulseBot/1.0"
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return result;
    const html = await res.text();

    // Extract Open Graph image
    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogImageMatch && ogImageMatch[1]) {
      result.coverImage = ogImageMatch[1];
    } else {
      // Fallback: twitter image
      const twitterImageMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      if (twitterImageMatch && twitterImageMatch[1]) {
        result.coverImage = twitterImageMatch[1];
      }
    }

    // Extract Meta description
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (descMatch && descMatch[1]) {
      result.description = descMatch[1];
    }

  } catch (err) {
    console.warn("Failed to scrape metadata for URL:", url, err.message);
  }

  return result;
}

async function generateAIArticle(title, url, scrapedDesc) {
  const prompt = `You are a high-profile technology journalist writing for DevPulse.
Create a fully detailed, engaging, and professional 400-600 word technical article about:
Topic: "${title}"
URL: ${url}
Context Info: ${scrapedDesc || "Developer breaking news"}

Requirements:
- Structure with clear ## Markdown Headers.
- Start with a compelling bold introduction about "Why it matters".
- Explain the key mechanics, features, or architecture details.
- Provide a dedicated "Developer Impact" section explaining how this affects workflows, tools, or best practices.
- Use a code snippet, bullet lists, or tables if helpful to convey dev points.
- Do not repeat yourself. Write in a premium, engaging editorial tone.

Output the article in Markdown format. Do not add introductory conversational text like "Here is your article:". Just return the Markdown itself.`;

  let resultText = null;
  let usedModel = null;

  // Try models in rotation order
  for (let attempts = 0; attempts < MODELS.length; attempts++) {
    const model = MODELS[modelIndex];
    // Rotate modelIndex
    modelIndex = (modelIndex + 1) % MODELS.length;

    try {
      if (model.provider === "gemini") {
        const { key: apiKey, index: keyIndex } = keyManager.getAvailableKey();
        if (!apiKey) continue;
        keyManager.incrementRequest(keyIndex);

        const apiUr = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${apiKey}`;
        const res = await fetch(apiUr, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1500, temperature: 0.3 }
          })
        });

        if (res.status === 429) {
          keyManager.handle429(keyIndex);
          continue;
        }

        if (res.ok) {
          const json = await res.json();
          resultText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
          usedModel = model.id;
          break;
        }
      } else {
        // Groq Fallback
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) continue;

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1500,
            temperature: 0.3,
          })
        });

        if (res.ok) {
          const json = await res.json();
          resultText = json?.choices?.[0]?.message?.content;
          usedModel = model.id;
          break;
        }
      }
    } catch (e) {
      console.error(`Attempt with ${model.id} failed:`, e);
    }
  }

  return { content: resultText, model: usedModel };
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const { title, url, source = "hackernews", tags = [] } = await req.json();
    if (!title) {
      return new Response(JSON.stringify({ error: "Missing title" }), { status: 400, headers: corsHeaders });
    }

    // 1. Scrape original page
    const metadata = await scrapeMetadata(url);

    // 2. Generate original DevPulse Article via AI
    const { content, model } = await generateAIArticle(title, url, metadata.description);

    if (!content) {
      return new Response(JSON.stringify({ error: "AI generation failed across all models." }), { status: 502, headers: corsHeaders });
    }

    // Generate unique ID
    const articleId = `dp-${Date.now()}`;
    const generatedAt = new Date().toISOString();

    // Word count / read time
    const words = content.split(/\s+/).length;
    const readTime = Math.max(1, Math.round(words / 200));

    // Excerpt: first 160 chars from the content (strip markdown)
    const excerpt = content
      .replace(/[#*`_-]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 160)
      .trim() + "...";

    const articleData = {
      id: articleId,
      title,
      content,
      excerpt,
      coverImage: metadata.coverImage || "",
      sourceUrl: url,
      sourceTitle: title,
      source,
      tags,
      model: model || "unknown",
      generatedAt,
      readTime
    };

    // 3. Save to Netlify Blobs
    const store = getStore("articles");
    await store.setJSON(articleId, articleData);

    // 4. Update the Index Blob ('article-index')
    let index = [];
    try {
      index = (await store.getJSON("article-index")) || [];
    } catch {
      // Index does not exist yet
    }

    index.unshift({
      id: articleId,
      title,
      excerpt,
      coverImage: metadata.coverImage || "",
      source,
      tags,
      generatedAt,
      readTime,
      model
    });

    // Save index
    await store.setJSON("article-index", index);

    return new Response(JSON.stringify(articleData), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to generate article", detail: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/api/generate-article", method: "POST" };
