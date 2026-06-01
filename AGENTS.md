# AGENTS.md

Instructions for AI coding agents working on this repository.

## Project Context

- This is DevPulse, a static frontend plus Netlify Functions tech-news application.
- Production hosting is Netlify. Keep backend work compatible with Netlify Functions.
- Do not introduce Express, long-running servers, databases, or paid services unless the user explicitly approves.
- Prefer free/no-key provider behavior, with optional environment variables only when they improve reliability.

## Core Rules

- Do not assume. Inspect the repository and verify behavior before deciding.
- If a task depends on current external docs, APIs, pricing, provider behavior, deployment behavior, or package behavior, search online and use official documentation whenever possible.
- Do not change production behavior based only on memory of how a provider works.
- Keep changes scoped to the user request. Do not refactor unrelated code.
- Preserve user changes. Never revert work you did not make unless the user explicitly asks.
- Explain important uncertainty clearly instead of hiding it.

## Git and Deployment Workflow

- Always commit after making code or documentation changes.
- Do not push until the user asks for deploy/push or explicitly approves pushing.
- The user should test locally before deployment whenever possible.
- After committing, tell the user the commit hash and exactly what changed.
- Before pushing, confirm the working tree is clean or explain any remaining uncommitted files.
- Never run destructive git commands such as `git reset --hard` or `git checkout --` unless the user explicitly asks.

## Local Testing Expectations

- Do not use the in-app browser or browser automation unless the user explicitly asks. The user prefers to test locally to save quota.
- For JavaScript or Netlify Function changes, run syntax/import checks when practical.
- For provider/feed changes, verify upstream endpoints with lightweight command-line checks when practical.
- If Netlify CLI or a dev server cannot run locally, say so and provide the exact command the user should run.
- Do not claim deployment success unless the change was pushed and the deploy result was verified or reported by the user.

## Netlify Functions

- Keep API routes under `netlify/functions`.
- Preserve CORS handling for public API routes.
- Cache external feed responses with Netlify Blobs where appropriate.
- Return stale cached data when upstream providers fail whenever possible.
- Normalize feed items with common fields such as `id`, `title`, `url`, `link`, `source`, timestamps, score/comment fields, tags, and description/summary.
- Avoid fragile scraping as the only path for a provider. Prefer official APIs or RSS first, scraping only as fallback.

## Frontend

- Keep the current DevPulse design intact unless the user requests design changes.
- Make feed behavior source-balanced where possible so the home feed mixes providers.
- Article reader behavior should degrade gracefully: full content first, partial content next, feed excerpt next, then a clear error with source link and AI option.
- Dev.to Markdown should render images, links, lists, headings, and code blocks correctly.
- Do not add visible instructional text or marketing sections unless requested.

## AI Features

- Treat AI output as analysis, summary, or assistant help, not as authoritative reporting.
- Prefer AI modes that help developers understand impact: TL;DR, Developer Impact, Technical Deep Dive, Pros/Cons, Action Items, and Ask About This Story.
- Do not present generated content as original source truth.
- Use source article text, metadata, or feed excerpt as grounding whenever possible.

## Provider Safety

- Respect provider rate limits.
- Use optional keys such as `GITHUB_TOKEN`, `DEVTO_API_KEY`, `GEMINI_API_KEY`, and `GROQ_API_KEY` only through environment variables.
- Never hard-code secrets, tokens, or private credentials.
- Add fallbacks for providers likely to block scraping or rate-limit unauthenticated calls.

## Documentation Sources

- AGENTS.md is the repository-level instruction file for agents, based on the public AGENTS.md convention and OpenAI Codex AGENTS.md guidance.
- When updating provider behavior, prefer official docs for DEV/Forem, Hacker News, GitHub, Netlify, and each feed provider.
