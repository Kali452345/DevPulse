// devto.mjs — Dev.to Proxy (Netlify Function)
// Fetches top 30 articles from Dev.to with 5-minute in-memory cache.

const DEVTO_URL = "https://dev.to/api/articles?per_page=30&top=1";

// ── In-memory cache ────────────────────────────────────────────────
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cache = { data: null, timestamp: 0 };

// ── CORS headers applied to every response ─────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Normalize a Dev.to article into the DevPulse standard shape.
 */
function normalize(article) {
  return {
    id: article.id,
    title: article.title,
    url: article.url,
    points: article.positive_reactions_count,
    author: article.user?.name ?? article.user?.username ?? "Unknown",
    time: article.published_at,
    comments: article.comments_count,
    tags: article.tag_list,
    cover_image: article.cover_image || article.social_image || "",
    description: article.description || "",
    source: "devto",
  };
}

export default async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Return cached data if still fresh
    const now = Date.now();
    if (cache.data && now - cache.timestamp < CACHE_TTL) {
      return new Response(JSON.stringify(cache.data), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build request headers — include API key if available
    const headers = { Accept: "application/json" };
    const apiKey = process.env.DEVTO_API_KEY;
    if (apiKey) {
      headers["api-key"] = apiKey;
    }

    // Fetch from Dev.to
    const res = await fetch(DEVTO_URL, { headers });
    if (!res.ok) {
      throw new Error(`Dev.to returned ${res.status}`);
    }

    const articles = await res.json();
    const normalized = articles.map(normalize);

    // Update cache
    cache = { data: normalized, timestamp: now };

    return new Response(JSON.stringify(normalized), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch Dev.to articles", detail: err.message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

// Netlify Functions v2 config
export const config = { path: "/api/devto" };
