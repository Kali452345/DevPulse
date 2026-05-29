// hn.mjs — HackerNews Proxy (Netlify Function)
// Fetches top 30 stories from HN Algolia API with 5-minute in-memory cache.

const ALGOLIA_URL =
  "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30";

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
 * Normalize an Algolia hit into the DevPulse standard shape.
 */
function normalize(hit) {
  return {
    id: hit.objectID,
    title: hit.title,
    url: hit.url,
    points: hit.points,
    author: hit.author,
    time: hit.created_at,
    comments: hit.num_comments,
    source: "hackernews",
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

    // Fetch from Algolia
    const res = await fetch(ALGOLIA_URL);
    if (!res.ok) {
      throw new Error(`Algolia returned ${res.status}`);
    }

    const json = await res.json();
    const stories = (json.hits || []).map(normalize);

    // Update cache
    cache = { data: stories, timestamp: now };

    return new Response(JSON.stringify(stories), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch HackerNews stories", detail: err.message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

// Netlify Functions v2 config
export const config = { path: "/api/hn" };
