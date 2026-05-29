// articles.mjs — DevPulse Articles CRUD (Netlify Function)
// Retrieves list of articles, returns details of a specific article,
// or deletes an article, using Netlify Blobs.

import { getStore } from "@netlify/blobs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const urlObj = new URL(req.url);
  const id = urlObj.searchParams.get("id");

  try {
    const store = getStore("articles");

    // ── DELETE Article ───────────────────────────────────────────────
    if (req.method === "DELETE") {
      if (!id) {
        return new Response(JSON.stringify({ error: "Missing article ID" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Delete item
      await store.delete(id);

      // Remove from index
      let index = [];
      try {
        index = (await store.getJSON("article-index")) || [];
      } catch (err) {
        console.error('Articles store error reading index for delete:', err);
      }

      const updatedIndex = index.filter((item) => item.id !== id);
      await store.setJSON("article-index", updatedIndex);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ── GET Single Article ───────────────────────────────────────────
    if (id) {
      const article = await store.getJSON(id);
      if (!article) {
        return new Response(JSON.stringify({ error: "Article not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify(article), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ── GET Article Index ────────────────────────────────────────────
    let index = [];
    try {
      index = (await store.getJSON("article-index")) || [];
    } catch (err) {
      console.error('Articles store error reading index:', err);
    }

    // Support pagination: ?page=1&limit=10
    const page = parseInt(urlObj.searchParams.get("page") || "1", 10);
    const limit = parseInt(urlObj.searchParams.get("limit") || "10", 10);
    const startIndex = (page - 1) * limit;
    const paginatedIndex = index.slice(startIndex, startIndex + limit);

    return new Response(JSON.stringify({
      articles: paginatedIndex,
      totalCount: index.length,
      page,
      limit
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal server error", detail: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/api/articles" };
