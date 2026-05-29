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

import * as cheerio from "cheerio";

// Simple web scraper to extract cover image and description using cheerio
async function scrapeMetadata(url) {
  const result = { coverImage: "", description: "", textContent: "" };
  if (!url || url === "#") return result;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8-second limit

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DevPulseBot/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return result;
    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract Open Graph image
    result.coverImage = $('meta[property="og:image"]').attr('content') ||
                        $('meta[name="twitter:image"]').attr('content') || "";

    // Extract Meta description
    result.description = $('meta[name="description"]').attr('content') ||
                         $('meta[property="og:description"]').attr('content') || "";

    // Extract raw text content for AI to read
    $('script, style, noscript, iframe, nav, footer, header').remove();
    let textBody = '';
    $('article p, main p, .post-content p, .article-content p').each((_, el) => {
      textBody += $(el).text() + '\n\n';
    });

    // Fallback if no specific article paragraphs found
    if (textBody.length < 200) {
      textBody = $('body').text().replace(/\s+/g, ' ');
    }

    // Limit text to ~20k characters to fit within context windows safely
    result.textContent = textBody.slice(0, 20000);

  } catch (err) {
    console.warn("Failed to scrape metadata for URL:", url, err.message);
  }

  return result;
}

// Fetch Dev.to article natively
async function fetchNativeDevToArticle(url) {
  try {
    const apiRes = await fetch(`https://dev.to/api/articles/find?url=${encodeURIComponent(url)}`);
    if (apiRes.ok) {
      const data = await apiRes.json();
      return {
        content: data.body_markdown || data.description,
        coverImage: data.cover_image || data.social_image || "",
        model: "Native Dev.to Source"
      };
    }
  } catch (e) {
    console.warn("Native Dev.to fetch failed:", e.message);
  }
  return null;
}

async function generateAIArticle(title, url, scrapedDesc, scrapedContent) {
  const prompt = \`You are a high-profile technology journalist writing for DevPulse.
Create a fully detailed, engaging, and professional technical article about:
Topic: "\${title}"
URL: \${url}
Context Description: \${scrapedDesc || "Developer breaking news"}

Here is the extracted raw content from the source page. Use this as your primary factual basis. Summarize and structure it beautifully. DO NOT hallucinate facts not present here.
RAW CONTENT:
\${scrapedContent}
---

Requirements:
- Structure with clear ## Markdown Headers.
- Start with a compelling bold introduction about "Why it matters".
- Explain the key mechanics, features, or architecture details found in the raw content.
- Provide a dedicated "Developer Impact" section explaining how this affects workflows, tools, or best practices.
- Output the article in Markdown format. Do not add introductory conversational text like "Here is your article:". Just return the Markdown itself.\`;

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

        const apiUr = \`https://generativelanguage.googleapis.com/v1beta/models/\${model.id}:generateContent?key=\${apiKey}\`;
        const res = await fetch(apiUr, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 2500, temperature: 0.3 }
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
            Authorization: \`Bearer \${apiKey}\`,
          },
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 2500,
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
      console.error(\`Attempt with \${model.id} failed:\`, e);
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
    const { title, url, source = "unknown", tags = [] } = await req.json();
    if (!title) {
      return new Response(JSON.stringify({ error: "Missing title" }), { status: 400, headers: corsHeaders });
    }

    let finalContent = null;
    let finalModel = null;
    let finalCoverImage = "";
    
    // 1. If it's a dev.to article, natively fetch its exact content
    const isDevTo = source === "devto" || url.includes("dev.to");
    if (isDevTo) {
      const nativeData = await fetchNativeDevToArticle(url);
      if (nativeData && nativeData.content) {
        finalContent = nativeData.content;
        finalModel = nativeData.model;
        finalCoverImage = nativeData.coverImage;
      }
    }

    // 2. If no native content yet, scrape and use AI
    if (!finalContent) {
      const metadata = await scrapeMetadata(url);
      const aiResult = await generateAIArticle(title, url, metadata.description, metadata.textContent);
      
      finalContent = aiResult.content;
      finalModel = aiResult.model;
      finalCoverImage = metadata.coverImage;
    }

    if (!finalContent) {
      return new Response(JSON.stringify({ error: "Content generation failed." }), { status: 502, headers: corsHeaders });
    }

    // Generate unique ID
    const articleId = \`dp-\${Date.now()}\`;
    const generatedAt = new Date().toISOString();

    // Word count / read time
    const words = finalContent.split(/\\s+/).length;
    const readTime = Math.max(1, Math.round(words / 200));

    // Excerpt: first 160 chars from the content (strip markdown)
    const excerpt = finalContent
      .replace(/[#*\`_-]/g, "")
      .replace(/\\s+/g, " ")
      .slice(0, 160)
      .trim() + "...";

    const articleData = {
      id: articleId,
      title,
      content: finalContent,
      excerpt,
      coverImage: finalCoverImage || "",
      sourceUrl: url,
      sourceTitle: title,
      source,
      tags,
      model: finalModel || "unknown",
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
