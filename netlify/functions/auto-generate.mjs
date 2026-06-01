// auto-generate.mjs — Scheduled Article Auto-Generator (Netlify Function)
// Runs every 6 hours to fetch top stories from external feeds,
// identifies stories that haven't been summarized/rewritten yet,
// and auto-generates Netlify Blob articles for the top 5 stories.

import { getStore } from "@netlify/blobs";

// Scraper metadata extractor
async function scrapeMetadata(url) {
  const result = { coverImage: "", description: "" };
  if (!url || url === "#") return result;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 DevPulseBot/1.0" }
    });
    clearTimeout(timeout);
    if (!res.ok) return result;
    const html = await res.text();
    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogImageMatch && ogImageMatch[1]) result.coverImage = ogImageMatch[1];
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (descMatch && descMatch[1]) result.description = descMatch[1];
  } catch {}
  return result;
}

// Model prompt router
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
- Format in premium Markdown. Do not add introductory comments. Output only Markdown.`;

  const keys = (process.env.GEMINI_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return { content: null, model: null };

  let keyIndex = 0;
  const apiKey = keys[keyIndex % keys.length];
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.3 }
      })
    });
    if (res.ok) {
      const json = await res.json();
      return { content: json?.candidates?.[0]?.content?.parts?.[0]?.text, model: "gemini-2.5-flash" };
    }
  } catch (err) {
    console.error("Auto-generate AI request failed:", err);
  }

  // Fallback to Groq
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1500,
          temperature: 0.3,
        })
      });
      if (res.ok) {
        const json = await res.json();
        return { content: json?.choices?.[0]?.message?.content, model: "llama-3.3-70b-versatile" };
      }
    } catch {}
  }

  return { content: null, model: null };
}

export default async () => {
  console.log("Auto-generate article scheduled job started...");

  try {
    // 1. Fetch external feeds
    const [hnRes, devtoRes, aiRes] = await Promise.allSettled([
      fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20"),
      fetch("https://dev.to/api/articles?per_page=20&top=1"),
      fetch("https://tensorfeed.ai/api/news")
    ]);

    let candidates = [];

    // HN Candidates
    if (hnRes.status === "fulfilled" && hnRes.value.ok) {
      const json = await hnRes.value.json();
      (json.hits || []).forEach(h => {
        if (h.title && h.url) {
          candidates.push({ title: h.title, url: h.url, points: h.points || 0, source: "hackernews", tags: [] });
        }
      });
    }

    // Dev.to Candidates
    if (devtoRes.status === "fulfilled" && devtoRes.value.ok) {
      const articles = await devtoRes.value.json();
      articles.forEach(a => {
        if (a.title && a.url) {
          candidates.push({ title: a.title, url: a.url, points: a.positive_reactions_count || 0, source: "devto", tags: a.tag_list || [] });
        }
      });
    }

    // AI Candidates
    if (aiRes.status === "fulfilled" && aiRes.value.ok) {
      const items = await aiRes.value.json();
      const articles = Array.isArray(items) ? items : items.data ?? items.articles ?? [];
      articles.forEach(a => {
        if (a.title && a.url) {
          candidates.push({ title: a.title, url: a.url, points: 50, source: "ai-news", tags: [] });
        }
      });
    }

    if (candidates.length === 0) {
      console.log("No candidates found from any feeds.");
      return;
    }

    // 2. Load existing articles from index to prevent duplicates
    const store = getStore("articles");
    let index = [];
    try {
      index = (await store.getJSON("article-index")) || [];
    } catch {}

    const existingUrls = new Set(index.map(item => item.sourceUrl));
    const ungenerated = candidates.filter(c => !existingUrls.has(c.url));

    if (ungenerated.length === 0) {
      console.log("All candidates are already generated.");
      return;
    }

    // Sort by engagement points descending
    ungenerated.sort((a, b) => b.points - a.points);

    // Limit to 3 articles per cron job run to stay within rate limit safely
    const toGenerate = ungenerated.slice(0, 3);
    console.log(`Picked ${toGenerate.length} candidates to auto-generate:`, toGenerate.map(t => t.title));

    for (const item of toGenerate) {
      try {
        console.log(`Processing: "${item.title}"`);
        const metadata = await scrapeMetadata(item.url);
        const { content, model } = await generateAIArticle(item.title, item.url, metadata.description);

        if (!content) {
          console.warn(`Failed to generate AI content for: ${item.title}`);
          continue;
        }

        const articleId = `dp-${Date.now()}`;
        const generatedAt = new Date().toISOString();
        const words = content.split(/\s+/).length;
        const readTime = Math.max(1, Math.round(words / 200));

        const excerpt = content
          .replace(/[#*`_-]/g, "")
          .replace(/\s+/g, " ")
          .slice(0, 160)
          .trim() + "...";

        const articleData = {
          id: articleId,
          title: item.title,
          content,
          excerpt,
          coverImage: metadata.coverImage || "",
          sourceUrl: item.url,
          sourceTitle: item.title,
          source: item.source,
          tags: item.tags,
          model: model || "unknown",
          generatedAt,
          readTime
        };

        // Save article
        await store.setJSON(articleId, articleData);

        // Update index list
        index.unshift({
          id: articleId,
          title: item.title,
          excerpt,
          coverImage: metadata.coverImage || "",
          source: item.source,
          tags: item.tags,
          generatedAt,
          readTime,
          model,
          sourceUrl: item.url || ""
        });

        // Add small pause between generations
        await new Promise(resolve => setTimeout(resolve, 5000));

      } catch (err) {
        console.error(`Error auto-generating article "${item.title}":`, err);
      }
    }

    // Save final updated index
    await store.setJSON("article-index", index);
    console.log("Auto-generate articles job finished successfully.");

  } catch (err) {
    console.error("Auto-generate job encountered a fatal error:", err);
  }
};

export const config = {
  schedule: "0 */6 * * *" // Run every 6 hours
};
