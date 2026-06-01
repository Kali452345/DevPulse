import { getStore } from "@netlify/blobs";

const CACHE_TTL = 30 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const urlObj = new URL(req.url);
  const force = urlObj.searchParams.get("force") === "true";
  const store = getStore("feeds");

  try {
    if (!force) {
      const cached = await getCached(store, "ai-feed");
      if (cached) return json(cached.articles, { "X-Cache": "HIT" });
    }

    let articles = await fetchTensorFeed();
    if (!articles.length) articles = await fetchHnAiFallback();
    if (!articles.length) return await staleOrEmpty(store, "ai-feed");

    await store.setJSON("ai-feed", { articles, timestamp: Date.now() });
    return json(articles, { "X-Cache": "MISS" });
  } catch (err) {
    console.error("AI News endpoint error:", err.message);
    return await staleOrEmpty(store, "ai-feed");
  }
};

export const config = { path: "/api/ai-news" };

async function fetchTensorFeed() {
  try {
    const res = await fetchWithTimeout("https://tensorfeed.ai/api/news", 7000);
    if (!res.ok) return [];
    const raw = await res.json();
    const items = Array.isArray(raw) ? raw : raw.data ?? raw.articles ?? raw.items ?? [];
    return items.map((item, i) => {
      const date = item.date || item.published_at || item.publishedAt || item.created_at || new Date().toISOString();
      return {
        id: item.id || item.url || item.link || `ai-${Date.now()}-${i}`,
        title: item.title || item.headline || "Untitled",
        url: item.url || item.link || "#",
        link: item.url || item.link || "#",
        date,
        published_at: date,
        time: date,
        summary: item.summary || item.description || item.snippet || "",
        description: item.summary || item.description || item.snippet || "",
        author: item.author || item.provider || item.source || "",
        tags: item.tags || item.categories || ["ai"],
        source: "ai-news",
      };
    }).filter((item) => item.title && item.url !== "#");
  } catch {
    return [];
  }
}

async function fetchHnAiFallback() {
  const queries = [
    "AI LLM ChatGPT Claude Gemini Anthropic OpenAI",
    "machine learning neural network deep learning transformer diffusion",
  ];

  const responses = await Promise.all(queries.map((query) =>
    fetchWithTimeout(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=40`, 8000)
      .catch(() => null)
  ));

  const seen = new Set();
  const articles = [];
  for (const res of responses) {
    if (!res?.ok) continue;
    const data = await res.json();
    for (const h of (data.hits || [])) {
      if (!h.title || seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      articles.push({
        id: `ai-${h.objectID}`,
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        by: h.author || "",
        author: h.author || "",
        date: h.created_at || "",
        published_at: h.created_at || "",
        time: h.created_at || "",
        points: h.points || 0,
        score: h.points || 0,
        descendants: h.num_comments || 0,
        comments_count: h.num_comments || 0,
        summary: "",
        description: "",
        tags: ["ai", "machine-learning"],
        source: "ai-news",
      });
    }
  }
  return articles.sort((a, b) => (b.points || 0) - (a.points || 0));
}

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...headers },
  });
}

async function getCached(store, key) {
  try {
    const cached = await store.get(key, { type: "json" });
    if (cached?.timestamp && Date.now() - cached.timestamp < CACHE_TTL) return cached;
  } catch {}
  return null;
}

async function staleOrEmpty(store, key) {
  try {
    const stale = await store.get(key, { type: "json" });
    if (stale?.articles) return json(stale.articles, { "X-Cache": "STALE" });
  } catch {}
  return json([]);
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
