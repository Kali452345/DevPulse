import { getStore } from "@netlify/blobs";

const CACHE_TTL = 15 * 60 * 1000;

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
      const cached = await getCached(store, "hn-feed");
      if (cached) return json(cached.articles, { "X-Cache": "HIT" });
    }

    const [topRes, bestRes] = await Promise.all([
      fetchWithTimeout("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60", 8000),
      fetchWithTimeout("https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=40&page=1", 8000),
    ]);

    if (!topRes.ok && !bestRes.ok) return await staleOrEmpty(store, "hn-feed");

    const seen = new Set();
    const articles = [];
    for (const res of [topRes, bestRes]) {
      if (!res.ok) continue;
      const data = await res.json();
      for (const h of (data.hits || [])) {
        if (!h.title || seen.has(h.objectID)) continue;
        seen.add(h.objectID);
        articles.push({
          id: h.objectID,
          title: h.title,
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          by: h.author || "",
          author: h.author || "",
          time: h.created_at || new Date((h.created_at_i || 0) * 1000).toISOString(),
          points: h.points || 0,
          score: h.points || 0,
          descendants: h.num_comments || 0,
          comments_count: h.num_comments || 0,
          source: "hackernews",
        });
      }
    }

    await store.setJSON("hn-feed", { articles, timestamp: Date.now() });
    return json(articles, { "X-Cache": "MISS" });
  } catch (err) {
    console.error("HackerNews endpoint error:", err.message);
    return await staleOrEmpty(store, "hn-feed");
  }
};

export const config = { path: "/api/hn" };

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
