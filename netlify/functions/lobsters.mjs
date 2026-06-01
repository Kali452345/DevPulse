import { getStore } from "@netlify/blobs";

const CACHE_TTL = 20 * 60 * 1000;

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
      const cached = await getCached(store, "lobsters-feed");
      if (cached) return json(cached.articles, { "X-Cache": "HIT" });
    }

    const res = await fetchWithTimeout("https://lobste.rs/hottest.json", {
      headers: {
        "Accept": "application/json",
        "User-Agent": "DevPulse/1.0 (+https://devpulse.netlify.app)",
      },
    }, 10000);

    if (!res.ok) return await staleOrEmpty(store, "lobsters-feed");

    const data = await res.json();
    const articles = (Array.isArray(data) ? data : []).map((item) => ({
      id: `lbs-${item.short_id || item.url || item.created_at}`,
      title: item.title || "Untitled",
      url: item.url || `https://lobste.rs/s/${item.short_id}`,
      link: item.url || `https://lobste.rs/s/${item.short_id}`,
      author: item.submitter_user?.username || "",
      by: item.submitter_user?.username || "",
      time: item.created_at || "",
      published_at: item.created_at || "",
      points: item.score || 0,
      score: item.score || 0,
      comments_count: item.comment_count || 0,
      descendants: item.comment_count || 0,
      tags: item.tags || [],
      description: item.description || "",
      source: "lobsters",
    }));

    await store.setJSON("lobsters-feed", { articles, timestamp: Date.now() });
    return json(articles, { "X-Cache": "MISS" });
  } catch (err) {
    console.error("Lobsters endpoint error:", err.message);
    return await staleOrEmpty(store, "lobsters-feed");
  }
};

export const config = { path: "/api/lobsters" };

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

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

