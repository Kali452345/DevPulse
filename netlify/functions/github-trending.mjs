import { getStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

const CACHE_TTL = 30 * 60 * 1000;

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
  const since = urlObj.searchParams.get("since") || "daily";
  const lang = urlObj.searchParams.get("lang") || "";
  const force = urlObj.searchParams.get("force") === "true";
  const cacheKey = `github-${since}-${lang}`;
  const store = getStore("feeds");

  try {
    if (!force) {
      const cached = await getCached(store, cacheKey);
      if (cached) return json(cached.articles, { "X-Cache": "HIT" });
    }

    let articles = await fetchSearchFallback();
    if (!articles.length) articles = await fetchTrendingPage(since, lang);
    if (!articles.length) return await staleOrEmpty(store, cacheKey);

    await setCached(store, cacheKey, articles);
    return json(articles, { "X-Cache": "MISS" });
  } catch (err) {
    console.error("GitHub trending endpoint error:", err.message);
    return await staleOrEmpty(store, cacheKey);
  }
};

export const config = { path: "/api/github-trending" };

async function fetchTrendingPage(since, lang) {
  const url = `https://github.com/trending${lang ? `/${encodeURIComponent(lang)}` : ""}?since=${encodeURIComponent(since)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; DevPulse/1.0; +https://devpulse.netlify.app)",
    },
  }, 12000);

  if (!res.ok) return [];

  const html = await res.text();
  const $ = cheerio.load(html);
  const articles = [];

  $("article.Box-row").each((_, el) => {
    const nameEl = $(el).find("h2 a");
    const nameRaw = nameEl.text().replace(/\s+/g, " ").trim();
    if (!nameRaw) return;

    const href = nameEl.attr("href") || "";
    const repoUrl = `https://github.com${href}`;
    const desc = $(el).find("p").text().trim();
    const starsText = $(el).find("a[href$='/stargazers']").text().replace(/\s+/g, "").trim();
    const stars = parseInt(starsText.replace(/,/g, ""), 10) || 0;
    const forksText = $(el).find("a[href$='/forks']").text().replace(/\s+/g, "").trim();
    const forks = parseInt(forksText.replace(/,/g, ""), 10) || 0;
    const language = $(el).find("[itemprop='programmingLanguage']").text().trim();
    const todayStars = $(el).find("span.d-inline-block").last().text().replace(/\s+/g, " ").trim();
    const [owner = "", name = nameRaw] = nameRaw.split("/").map((part) => part.trim());

    articles.push(normalizeRepo({
      id: `gh-${href.replace(/\//g, "-")}`,
      fullName: nameRaw,
      url: repoUrl,
      owner,
      name,
      description: desc,
      stars,
      forks,
      language,
      todayStars,
      pushedAt: new Date().toISOString(),
    }));
  });

  return articles;
}

async function fetchSearchFallback() {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "DevPulse/1.0",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `pushed:>${since} stars:>100 fork:false`;
  const res = await fetchWithTimeout(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=30`,
    { headers },
    12000,
  );

  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((repo) => normalizeRepo({
    id: `gh-${repo.id}`,
    fullName: repo.full_name,
    url: repo.html_url,
    owner: repo.owner?.login || "",
    name: repo.name,
    description: repo.description || "",
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    language: repo.language || "",
    todayStars: "",
    pushedAt: repo.pushed_at || repo.updated_at || repo.created_at,
  }));
}

function normalizeRepo(repo) {
  return {
    id: repo.id,
    title: `${repo.fullName} - ${repo.description?.slice(0, 90) || "Trending GitHub repo"}`,
    url: repo.url,
    link: repo.url,
    author: repo.owner,
    by: repo.owner,
    description: repo.description || "",
    summary: repo.description || "",
    time: repo.pushedAt || new Date().toISOString(),
    published_at: repo.pushedAt || new Date().toISOString(),
    points: repo.stars || 0,
    score: repo.stars || 0,
    comments_count: repo.forks || 0,
    descendants: repo.forks || 0,
    tags: repo.language ? [repo.language.toLowerCase()] : [],
    cover_image: "",
    repoName: repo.name,
    owner: repo.owner,
    stars: repo.stars || 0,
    forks: repo.forks || 0,
    language: repo.language || "",
    todayStars: repo.todayStars || "",
    source: "github",
  };
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

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
