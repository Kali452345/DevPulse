// ai-news.mjs — TensorFeed AI News Proxy (Netlify Function)
// Fetches AI/ML news from TensorFeed with graceful degradation.
// If TensorFeed is unreachable, returns an empty array instead of crashing.

const TENSORFEED_URL = "https://tensorfeed.ai/api/v1/news";

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
 * Normalize a TensorFeed item into the DevPulse standard shape.
 */
function normalize(item) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    summary: item.summary,
    time: item.time ?? item.published_at ?? item.created_at,
    source: "tensorfeed",
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

    // Attempt to fetch from TensorFeed (with a 5-second timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let stories;
    try {
      const res = await fetch(TENSORFEED_URL, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`TensorFeed returned ${res.status}`);
      }

      const json = await res.json();
      // Handle both array responses and { data: [...] } wrappers
      const items = Array.isArray(json) ? json : json.data ?? json.articles ?? [];
      stories = items.map(normalize);
    } catch (fetchErr) {
      clearTimeout(timeout);
      // TensorFeed is unreachable — return graceful fallback
      return new Response(
        JSON.stringify({ articles: [], error: "TensorFeed unavailable" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update cache
    cache = { data: stories, timestamp: now };

    return new Response(JSON.stringify(stories), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ articles: [], error: "TensorFeed unavailable" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

// Netlify Functions v2 config
export const config = { path: "/api/ai-news" };
