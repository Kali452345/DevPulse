import * as cheerio from "cheerio";

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
  const rawUrl = urlObj.searchParams.get("url");
  if (!rawUrl) return json({ ok: false, content: "", reason: "Missing url parameter" }, 400);

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(rawUrl);
    const parsed = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported protocol");
  } catch {
    return json({ ok: false, content: "", reason: "Invalid URL" }, 400);
  }

  if (targetUrl.includes("news.ycombinator.com/item")) {
    return json({ ok: false, content: "", reason: "HN discussion page" });
  }

  try {
    const githubReadme = await fetchGithubReadme(targetUrl);
    if (githubReadme) return json(githubReadme);

    const res = await fetchWithTimeout(targetUrl, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    }, 12000);

    if (!res.ok) return json({ ok: false, content: "", reason: `HTTP ${res.status}` });

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) return json({ ok: false, content: "", reason: "Not HTML" });

    const html = await res.text();
    const $ = cheerio.load(html);
    const { title, coverImage, content } = extractArticleContent($, targetUrl);
    const words = content.split(/\s+/).filter(Boolean).length;
    const readTime = Math.max(1, Math.round(words / 200));

    return json({
      ok: words > 80,
      title,
      coverImage,
      content,
      wordCount: words,
      readTime,
      url: targetUrl,
    });
  } catch (err) {
    return json({ ok: false, content: "", reason: err.message });
  }
};

export const config = { path: "/api/scrape" };

async function fetchGithubReadme(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.hostname !== "github.com") return null;
    const [, owner, repo] = parsed.pathname.split("/");
    if (!owner || !repo) return null;

    const headers = {
      "Accept": "application/vnd.github.raw",
      "User-Agent": "DevPulse/1.0",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    };
    const res = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers }, 10000);
    if (!res.ok) return null;

    const content = await res.text();
    const words = content.split(/\s+/).filter(Boolean).length;
    return {
      ok: words > 40,
      title: `${owner}/${repo}`,
      coverImage: "",
      content,
      wordCount: words,
      readTime: Math.max(1, Math.round(words / 200)),
      url: targetUrl,
    };
  } catch {
    return null;
  }
}

function extractArticleContent($, baseUrl) {
  $("script, style, noscript, nav, footer, header, aside, iframe").remove();
  $("[class*='sidebar'],[class*='cookie'],[class*='popup'],[class*='modal'],[class*='newsletter'],[class*='subscribe'],[class*='advertisement'],[class*='ad-'],[class*='banner'],[id*='sidebar'],[id*='cookie'],[id*='newsletter']").remove();

  const coverImage =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('meta[property="og:image:url"]').attr("content") ||
    "";

  const metaTitle =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    "";

  const pageTitle = metaTitle || $("h1").first().text().trim() || $("title").text().trim() || "";

  if (baseUrl.includes("github.com") && !baseUrl.includes("github.com/blog")) {
    const readme = $("#readme article, #readme .markdown-body, .repository-content .markdown-body").first();
    if (readme.length) {
      const readmeContent = extractNodes($, readme, { includeShortParagraphs: true });
      if (readmeContent.split(/\s+/).length > 80) {
        return { title: pageTitle, coverImage, content: readmeContent };
      }
    }
  }

  const selectors = [
    "article",
    "[class*='post-content']",
    "[class*='entry-content']",
    "[class*='article-body']",
    "[class*='article-content']",
    "[class*='post-body']",
    "[class*='blog-content']",
    "[class*='story-body']",
    "[class*='content-body']",
    "[class*='rich-text']",
    "main",
    "#main-content",
    "#content",
    ".content",
    "[role='main']",
  ];

  let contentEl = null;
  let bestLen = 0;
  for (const selector of selectors) {
    $(selector).each((_, node) => {
      const el = $(node);
      const len = el.find("p").map((__, p) => $(p).text()).get().join("").length;
      if (len > bestLen && len > 200) {
        bestLen = len;
        contentEl = el;
      }
    });
  }

  const content = extractNodes($, contentEl || $("body"), { includeShortParagraphs: false });
  return { title: pageTitle, coverImage, content };
}

function extractNodes($, root, { includeShortParagraphs }) {
  const parts = [];

  root.find("h1,h2,h3,h4,p,pre,ul,ol,blockquote").each((_, node) => {
    const tag = node.tagName?.toLowerCase();
    const el = $(node);
    if (!tag) return;

    if ((tag === "ul" || tag === "ol") && el.parents("ul,ol").length > 0) return;

    const text = el.text().trim();
    if (!text) return;

    if (/^h[1-4]$/.test(tag)) {
      parts.push(`${"#".repeat(Number(tag[1]))} ${text}`);
      return;
    }

    if (tag === "p") {
      if (includeShortParagraphs || text.length > 30) parts.push(text);
      return;
    }

    if (tag === "pre") {
      const code = el.find("code").text().trim() || text;
      parts.push("```\n" + code + "\n```");
      return;
    }

    if (tag === "ul" || tag === "ol") {
      const items = [];
      el.find("> li, li").each((i, li) => {
        const itemText = $(li).clone().find("ul,ol").remove().end().text().trim();
        if (itemText) items.push((tag === "ol" ? `${i + 1}. ` : "- ") + itemText);
      });
      if (items.length) parts.push(items.join("\n"));
      return;
    }

    if (tag === "blockquote") parts.push("> " + text.replace(/\n+/g, " "));
  });

  return parts.join("\n\n");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
