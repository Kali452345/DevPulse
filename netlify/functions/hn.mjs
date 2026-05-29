// hn.mjs — HackerNews Feed Proxy with Netlify Blobs Caching
// Fetches live from HN Algolia API and caches in Netlify Blobs.
// Subsequent visits read from Blobs (fast). Supports ?force=true to refresh.

import { getStore } from "@netlify/blobs";

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

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

  try {
    const store = getStore("feeds");

    // Check Blobs cache first
    if (!force) {
      try {
        const cached = await store.get("hn-feed", { type: "json" });
        if (cached && cached.timestamp && Date.now() - cached.timestamp < CACHE_TTL) {
          return new Response(JSON.stringify(cached.articles), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "X-Cache": "HIT",
              "X-Cache-Age": String(Math.round((Date.now() - cached.timestamp) / 1000)),
            },
          });
        }
      } catch (err) {
        console.warn("Blobs cache read failed for hn-feed:", err.message);
      }
    }

    // Fetch live from HN Algolia API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(
      "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30",
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      // Try returning stale cache if API fails
      try {
        const stale = await store.get("hn-feed", { type: "json" });
        if (stale && stale.articles) {
          return new Response(JSON.stringify(stale.articles), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "STALE" },
          });
        }
      } catch {}
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    const articles = (data.hits || [])
      .filter((h) => h.title)
      .map((h) => ({
        id: h.objectID,
        title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        by: h.author || "",
        author: h.author || "",
        time: h.created_at || new Date(h.created_at_i * 1000).toISOString(),
        points: h.points || 0,
        score: h.points || 0,
        descendants: h.num_comments || 0,
        comments_count: h.num_comments || 0,
        source: "hackernews",
      }));

    // Save to Netlify Blobs
    try {
      await store.setJSON("hn-feed", { articles, timestamp: Date.now() });
    } catch (err) {
      console.warn("Failed to save hn-feed to Blobs:", err.message);
    }

    return new Response(JSON.stringify(articles), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "MISS" },
    });

  } catch (err) {
    console.error("HackerNews endpoint error:", err);
    // Try stale cache on any error
    try {
      const store = getStore("feeds");
      const stale = await store.get("hn-feed", { type: "json" });
      if (stale && stale.articles) {
        return new Response(JSON.stringify(stale.articles), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "STALE" },
        });
      }
    } catch {}
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/hn" };
