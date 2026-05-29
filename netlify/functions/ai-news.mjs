// ai-news.mjs — TensorFeed AI News Proxy with Netlify Blobs Caching
// Fetches AI/ML news from TensorFeed and caches in Netlify Blobs.
// Subsequent visits read from Blobs. Supports ?force=true to refresh.

import { getStore } from "@netlify/blobs";

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

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
        const cached = await store.get("ai-feed", { type: "json" });
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
        console.warn("Blobs cache read failed for ai-feed:", err.message);
      }
    }

    // Fetch fresh from TensorFeed API with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let res;
    try {
      res = await fetch("https://tensorfeed.ai/api/v1/news", {
        signal: controller.signal,
      });
      clearTimeout(timeout);
    } catch (fetchErr) {
      clearTimeout(timeout);
      // API unreachable — try returning stale cache
      try {
        const stale = await store.get("ai-feed", { type: "json" });
        if (stale && stale.articles) {
          return new Response(JSON.stringify(stale.articles), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "STALE" },
          });
        }
      } catch {}
      return new Response(JSON.stringify({ articles: [], error: "TensorFeed unavailable" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!res.ok) {
      // Try stale cache
      try {
        const stale = await store.get("ai-feed", { type: "json" });
        if (stale && stale.articles) {
          return new Response(JSON.stringify(stale.articles), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "STALE" },
          });
        }
      } catch {}
      return new Response(JSON.stringify({ articles: [], error: `TensorFeed returned ${res.status}` }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const raw = await res.json();
    const items = Array.isArray(raw) ? raw : raw.data ?? raw.articles ?? [];

    const articles = items.map((item) => ({
      id: item.id || item.url || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: item.title || "Untitled",
      url: item.url || item.link || "#",
      link: item.url || item.link || "#",
      date: item.date || item.published_at || item.publishedAt || new Date().toISOString(),
      published_at: item.date || item.published_at || item.publishedAt || new Date().toISOString(),
      summary: item.summary || item.description || "",
      description: item.summary || item.description || "",
      author: item.author || item.source || "",
      tags: item.tags || item.categories || [],
      source: "ai-news",
    }));

    // Save to Netlify Blobs
    try {
      await store.setJSON("ai-feed", { articles, timestamp: Date.now() });
    } catch (err) {
      console.warn("Failed to save ai-feed to Blobs:", err.message);
    }

    return new Response(JSON.stringify(articles), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "MISS" },
    });

  } catch (err) {
    console.error("AI News endpoint error:", err);
    return new Response(JSON.stringify({ articles: [], error: err.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/ai-news" };
