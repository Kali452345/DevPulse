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

    let articles = await fetchJsonFeed();
    if (!articles.length) articles = await fetchRssFallback();
    if (!articles.length) return await staleOrEmpty(store, "lobsters-feed");

    await setCached(store, "lobsters-feed", articles);
    return json(articles, { "X-Cache": "MISS" });
  } catch (err) {
    console.error("Lobsters endpoint error:", err.message);
    return await staleOrEmpty(store, "lobsters-feed");
  }
};

export const config = { path: "/api/lobsters" };

async function fetchJsonFeed() {
  try {
    const res = await fetchWithTimeout("https://lobste.rs/hottest.json", {
      headers: {
        "Accept": "application/json",
        "User-Agent": "DevPulse/1.0 (+https://devpulse.netlify.app)",
      },
    }, 10000);
    if (!res.ok) return [];
    return normalizeJsonItems(await res.json());
  } catch {
    return [];
  }
}

function normalizeJsonItems(data) {
  return (Array.isArray(data) ? data : []).map((item) => ({
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
}

async function fetchRssFallback() {
  try {
    const res = await fetchWithTimeout("https://lobste.rs/rss", {
      headers: {
        "Accept": "application/rss+xml, application/xml, text/xml",
        "User-Agent": "DevPulse/1.0 (+https://devpulse.netlify.app)",
      },
    }, 10000);
    if (!res.ok) return [];

    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 30).map((match, i) => {
      const item = match[1];
      const title = decodeXml(pickXml(item, "title")) || "Untitled";
      const link = decodeXml(pickXml(item, "link")) || "https://lobste.rs";
      const description = stripHtml(decodeXml(pickXml(item, "description")));
      const pubDate = pickXml(item, "pubDate");
      const isoDate = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();
      return {
        id: `lbs-rss-${link || i}`,
        title,
        url: link,
        link,
        author: "",
        by: "",
        time: isoDate,
        published_at: isoDate,
        points: 0,
        score: 0,
        comments_count: 0,
        descendants: 0,
        tags: [],
        description,
        source: "lobsters",
      };
    });
  } catch {
    return [];
  }
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

async function setCached(store, key, articles) {
  try {
    await store.setJSON(key, { articles, timestamp: Date.now() });
  } catch (err) {
    console.warn(`Failed to save ${key} to Blobs:`, err.message);
  }
}

function pickXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim() || "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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
