// devto.mjs — Dev.to Feed Proxy with Netlify Blobs Caching
// Stores feed data in Netlify Blobs so page loads are instant.
// Supports ?force=true to refresh from the Dev.to API.
// Single article endpoint returns body_markdown for the reader.

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
  const id = urlObj.searchParams.get("id");
  const force = urlObj.searchParams.get("force") === "true";

  try {
    // ── Single Article Fetch (with markdown body) ──────────────────
    if (id) {
      const res = await fetchWithTimeout(`https://dev.to/api/articles/${id}`, {
        headers: {
          ...(process.env.DEVTO_API_KEY ? { "api-key": process.env.DEVTO_API_KEY } : {}),
          Accept: "application/json",
        },
      }, 8000);

      if (!res.ok) {
        return new Response(JSON.stringify({ error: `Dev.to API returned ${res.status}` }), {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const article = await res.json();

      return new Response(JSON.stringify({
        id: article.id,
        title: article.title,
        content: article.body_markdown || article.body_html || article.description || "",
        coverImage: article.cover_image || article.social_image || "",
        source: "devto",
        sourceUrl: article.url,
        readTime: article.reading_time_minutes || 3,
        generatedAt: article.published_at,
        tags: article.tag_list || article.tags || [],
        author: article.user?.name || article.user?.username || "",
        model: "dev.to native",
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Feed List (with Blobs caching) ─────────────────────────────
    const store = getStore("feeds");

    // Check Blobs cache first
    if (!force) {
      try {
        const cached = await store.get("devto-feed", { type: "json" });
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
        console.warn("Blobs cache read failed for devto-feed:", err.message);
      }
    }

    // Fetch fresh from Dev.to API
    const apiHeaders = {
      Accept: "application/json",
      ...(process.env.DEVTO_API_KEY ? { "api-key": process.env.DEVTO_API_KEY } : {}),
    };

    const res = await fetchWithTimeout("https://dev.to/api/articles?per_page=60&top=1", {
      headers: apiHeaders,
    }, 8000);

    if (!res.ok) {
      // Try returning stale cache if API fails
      try {
        const stale = await store.get("devto-feed", { type: "json" });
        if (stale && stale.articles) {
          return new Response(JSON.stringify(stale.articles), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "STALE" },
          });
        }
      } catch {}
      return new Response(JSON.stringify({ articles: [], error: `Dev.to API returned ${res.status}` }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await res.json();
    const articles = data.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      author: a.user?.name || a.user?.username || "",
      published_at: a.published_at,
      positive_reactions_count: a.positive_reactions_count || 0,
      comments_count: a.comments_count || 0,
      tags: a.tag_list || [],
      tag_list: a.tag_list || [],
      cover_image: a.cover_image || "",
      description: a.description || "",
      source: "devto",
    }));

    // Save to Netlify Blobs
    try {
      await store.setJSON("devto-feed", { articles, timestamp: Date.now() });
    } catch (err) {
      console.warn("Failed to save devto-feed to Blobs:", err.message);
    }

    return new Response(JSON.stringify(articles), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "MISS" },
    });

  } catch (err) {
    console.error("Dev.to endpoint error:", err);
    return new Response(JSON.stringify({ articles: [], error: err.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/devto" };

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
