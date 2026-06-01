/* ══════════════════════════════════════════════════
   DevPulse — App Logic v2
   All articles open inline — real scraping first, AI as fallback/enhancement
   Sources: HN · Dev.to · AI/ML · Lobsters · GitHub Trending · DevPulse Originals
   ══════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─── State ──────────────────────────────────────
  let allArticles    = [];      // all feed articles merged
  let devpulseArticles = [];    // ai-generated originals
  let activeFilter   = 'all';
  let searchQuery    = '';
  let themeMode      = localStorage.getItem('dp-theme') || 'dark';
  let notificationsEnabled = localStorage.getItem('dp-notifs') === 'true';

  const REFRESH_MS   = 5 * 60 * 1000;
  const SUMMARY_TTL  = 60 * 60 * 1000;

  // ─── DOM refs ────────────────────────────────────
  const feedEl        = document.getElementById('feed');
  const searchInput   = document.getElementById('search-input');
  const themeBtn      = document.getElementById('theme-btn');
  const notifBtn      = document.getElementById('notification-btn');
  const notifBadge    = document.getElementById('notification-badge');
  const statusText    = document.getElementById('status-text');
  const toastStack    = document.getElementById('toast-stack');

  // Strip
  const stripTotal    = document.getElementById('strip-total');
  const stripHn       = document.getElementById('strip-hn');
  const stripDevto    = document.getElementById('strip-devto');
  const stripAi       = document.getElementById('strip-ai');
  const stripLobsters = document.getElementById('strip-lobsters');
  const stripGithub   = document.getElementById('strip-github');
  const stripSaved    = document.getElementById('strip-saved');

  // Reader
  const readerOverlay  = document.getElementById('reader-overlay');
  const readerClose    = document.getElementById('reader-close');
  const readerTitle    = document.getElementById('reader-title');
  const readerProse    = document.getElementById('reader-prose');
  const readerBadge    = document.getElementById('reader-source-badge');
  const readerReadtime = document.getElementById('reader-readtime');
  const readerDate     = document.getElementById('reader-date');
  const readerOrigLink = document.getElementById('reader-orig-link');
  const readerModel    = document.getElementById('reader-model');
  const readerCoverWrap= document.getElementById('reader-cover-wrap');
  const readerCover    = document.getElementById('reader-cover');
  const readerAiBtn    = document.getElementById('reader-ai-btn');

  // Summary modal
  const modalVeil = document.getElementById('modal-veil');
  const smTitle   = document.getElementById('sm-title');
  const smBody    = document.getElementById('sm-body');
  const smModel   = document.getElementById('sm-model');
  const smClose   = document.getElementById('sm-close');

  const navBtns = document.querySelectorAll('.nav-btn');

  // ════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════
  const timeAgo = (d) => {
    if (!d) return '';
    const diff = Date.now() - new Date(d).getTime();
    if (diff < 0) return 'now';
    const s = Math.floor(diff / 1000);
    if (s < 60)  return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)  return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };

  const fmt = (n) => {
    if (!n) return '0';
    if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n/1e3).toFixed(1)}k`;
    return String(n);
  };

  const cacheGet = (k, maxAge) => {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (Date.now() - p.ts > maxAge) { localStorage.removeItem(k); return null; }
      return p.data;
    } catch { return null; }
  };

  const cacheSet = (k, data) => {
    try { localStorage.setItem(k, JSON.stringify({ data, ts: Date.now() })); } catch {}
  };

  const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ─── Markdown → HTML ─────────────────────────────
  const md = (text) => {
    if (!text) return '';
    let h = text;

    // Fenced code blocks first
    h = h.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) =>
      `<pre><code>${c.trim().replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`);

    // Inline code
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Headers
    h = h.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>');
    h = h.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/^#{1}\s+(.+)$/gm, '<h2>$1</h2>');

    // Bold + italic
    h = h.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    h = h.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    h = h.replace(/_([^_\n]+)_/g, '<em>$1</em>');

    // Unordered lists
    h = h.replace(/^[ \t]*[-*+]\s+(.+)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>[\s\S]+?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
    h = h.replace(/<\/ul>\s*<ul>/g, '');

    // Ordered lists
    h = h.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
    h = h.replace(/(<oli>[\s\S]+?<\/oli>)(?!\s*<oli>)/g, '<ol>$1</ol>');
    h = h.replace(/<\/ol>\s*<ol>/g, '');
    h = h.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');

    // Images, then links. The negative lookbehind keeps image markdown from
    // becoming a plain link in Dev.to articles.
    h = h.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      '<img src="$2" alt="$1" loading="lazy" referrerpolicy="no-referrer">');
    h = h.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Blockquotes
    h = h.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');
    h = h.replace(/<\/blockquote>\s*<blockquote>/g, '<br>');

    // Horizontal rule
    h = h.replace(/^---+$/gm, '<hr>');

    // Paragraphs — wrap non-tagged blocks
    const blocks = h.split(/\n{2,}/);
    h = blocks.map(block => {
      block = block.trim();
      if (!block) return '';
      if (/^<(h[2-4]|ul|ol|pre|blockquote|hr)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    return h;
  };

  // ════════════════════════════════════════════════
  //  TOAST
  // ════════════════════════════════════════════════
  const toast = (msg, type = 'error') => {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  };

  // ════════════════════════════════════════════════
  //  THEME
  // ════════════════════════════════════════════════
  const applyTheme = (t) => {
    const root = document.documentElement;
    if (t === 'light') {
      root.setAttribute('data-theme', 'light');
      themeBtn.textContent = '○';
    } else if (t === 'dark') {
      root.removeAttribute('data-theme');
      themeBtn.textContent = '◐';
    } else {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      dark ? root.removeAttribute('data-theme') : root.setAttribute('data-theme', 'light');
      themeBtn.textContent = '◑';
    }
  };

  themeBtn.addEventListener('click', () => {
    themeMode = themeMode === 'dark' ? 'light' : themeMode === 'light' ? 'system' : 'dark';
    localStorage.setItem('dp-theme', themeMode);
    applyTheme(themeMode);
    toast(`Theme: ${themeMode}`, 'success');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'system') applyTheme('system');
  });

  // ════════════════════════════════════════════════
  //  BOOKMARKS
  // ════════════════════════════════════════════════
  const getBookmarks = () => {
    try { return JSON.parse(localStorage.getItem('dp-bookmarks')) || []; } catch { return []; }
  };

  const isBookmarked = (id) => getBookmarks().some(b => (b.id || b.url) === id);

  const toggleBookmark = (article, e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    let bks = getBookmarks();
    const id = article.id || article.url;
    if (isBookmarked(id)) {
      bks = bks.filter(b => (b.id || b.url) !== id);
      toast('Removed from saved', 'success');
    } else {
      bks.push(article);
      toast('Saved to bookmarks', 'success');
    }
    localStorage.setItem('dp-bookmarks', JSON.stringify(bks));
    updateStrip();
    renderFeed();
  };

  // ════════════════════════════════════════════════
  //  NOTIFICATIONS
  // ════════════════════════════════════════════════
  notifBtn.addEventListener('click', async () => {
    notificationsEnabled = !notificationsEnabled;
    localStorage.setItem('dp-notifs', notificationsEnabled);
    if (notificationsEnabled) {
      if ('Notification' in window && Notification.permission !== 'granted') {
        await Notification.requestPermission();
      }
      toast('Notifications enabled', 'success');
    } else {
      toast('Notifications disabled');
    }
    notifBadge.style.display = 'none';
  });

  const scanBreaking = (articles) => {
    const notified = JSON.parse(localStorage.getItem('dp-notified') || '[]');
    let hasNew = false;
    articles.forEach(a => {
      const id = a.id || a.url;
      const pts = a.points || a.score || a.positive_reactions_count || 0;
      const breaking = (a.source === 'hackernews' && pts > 400) || (a.source === 'devto' && pts > 150);
      if (breaking && !notified.includes(id)) {
        notified.push(id);
        hasNew = true;
        if (notificationsEnabled && Notification.permission === 'granted') {
          try { new Notification(`⚡ DevPulse: ${a.title}`, { body: `${pts} points on ${a.source}` }); } catch {}
        }
      }
    });
    localStorage.setItem('dp-notified', JSON.stringify(notified));
    if (hasNew && !notificationsEnabled) notifBadge.style.display = 'block';
  };

  // ════════════════════════════════════════════════
  //  FETCH ALL FEEDS
  // ════════════════════════════════════════════════
  const fetchFeed = async (url, source) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      return (data.articles || data || []).map(a => ({ ...a, source: a.source || source }));
    } catch (err) {
      console.warn(`Feed ${source} failed:`, err.message);
      return [];
    }
  };

  const fetchDevpulseArticles = async () => {
    try {
      const res = await fetch('/api/articles');
      if (!res.ok) return;
      const data = await res.json();
      devpulseArticles = data.articles || [];
    } catch {}
  };

  const articleTime = (a) => new Date(a.time || a.published_at || a.date || a.generatedAt || 0).getTime() || 0;

  const mixSources = (groups) => {
    const buckets = groups
      .map(group => group.filter(Boolean).sort((a, b) => articleTime(b) - articleTime(a)))
      .filter(group => group.length > 0);

    const mixed = [];
    let added = true;
    while (added) {
      added = false;
      for (const bucket of buckets) {
        const next = bucket.shift();
        if (next) {
          mixed.push(next);
          added = true;
        }
      }
    }
    return mixed;
  };

  const fetchAll = async () => {
    renderSkeletons(12);

    const [devto, ai, hn, lobsters, github] = await Promise.all([
      fetchFeed('/api/devto', 'devto'),
      fetchFeed('/api/ai-news', 'ai-news'),
      fetchFeed('/api/hn', 'hackernews'),
      fetchFeed('/api/lobsters', 'lobsters'),
      fetchFeed('/api/github-trending', 'github'),
      fetchDevpulseArticles(),
    ]);

    allArticles = mixSources([hn, devto, ai, lobsters, github]);

    scanBreaking(allArticles);
    updateStrip();
    renderFeed();
  };

  const updateStrip = () => {
    const hn  = allArticles.filter(a => a.source === 'hackernews').length;
    const dt  = allArticles.filter(a => a.source === 'devto').length;
    const ai  = allArticles.filter(a => a.source === 'ai-news').length;
    const lbs = allArticles.filter(a => a.source === 'lobsters').length;
    const gh  = allArticles.filter(a => a.source === 'github').length;
    const sv  = getBookmarks().length;

    stripTotal.textContent    = `${allArticles.length} stories`;
    stripHn.textContent       = `△ HN ${hn}`;
    stripDevto.textContent    = `⬡ Dev.to ${dt}`;
    stripAi.textContent       = `◉ AI ${ai}`;
    stripLobsters.textContent = `⊛ Lobsters ${lbs}`;
    stripGithub.textContent   = `⌥ GitHub ${gh}`;
    stripSaved.textContent    = `◇ Saved ${sv}`;
  };

  // ════════════════════════════════════════════════
  //  SKELETON
  // ════════════════════════════════════════════════
  const renderSkeletons = (n = 12) => {
    feedEl.innerHTML = Array.from({ length: n }, (_, i) => `
      <div class="skel-card" style="animation-delay:${i * 35}ms">
        <div class="skel-line s"></div>
        <div class="skel-line xl"></div>
        <div class="skel-line l"></div>
        <div class="skel-line m"></div>
      </div>`).join('');
  };

  // ════════════════════════════════════════════════
  //  SOURCE CONFIG
  // ════════════════════════════════════════════════
  const SOURCE_CFG = {
    hackernews: { label: 'HN',       cls: 'hn'       },
    devto:      { label: 'Dev.to',   cls: 'devto'    },
    'ai-news':  { label: 'AI/ML',    cls: 'ai'       },
    lobsters:   { label: 'Lobsters', cls: 'lobsters' },
    github:     { label: 'GitHub',   cls: 'github'   },
  };

  // ════════════════════════════════════════════════
  //  RENDER FEED
  // ════════════════════════════════════════════════
  const renderFeed = () => {
    feedEl.innerHTML = '';

    // ── DevPulse Articles tab ──
    if (activeFilter === 'articles') {
      const filtered = devpulseArticles.filter(a => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (a.title || '').toLowerCase().includes(q) ||
               (a.excerpt || '').toLowerCase().includes(q) ||
               (a.tags || []).some(t => t.toLowerCase().includes(q));
      });

      if (filtered.length === 0) {
        feedEl.innerHTML = `<div class="feed-notice">
          <div class="feed-notice-title">No AI Articles Yet</div>
          <div class="feed-notice-sub">Open any story and click "Read →" — DevPulse will generate and save a full article</div>
        </div>`;
        return;
      }

      feedEl.innerHTML = filtered.map((a, i) => {
        const cover = a.coverImage
          ? `<div class="card-cover-wrap"><img class="card-cover" src="${esc(a.coverImage)}" alt="" loading="lazy"></div>`
          : '';
        const date = a.generatedAt ? new Date(a.generatedAt).toLocaleDateString() : '';
        return `
          <div class="article-card" data-dpid="${esc(a.id)}" style="animation-delay:${Math.min(i,10)*40}ms">
            <div class="card-header">
              <div class="card-meta">
                <span class="dp-badge">✦ DevPulse Original</span>
                <span class="card-time">${a.readTime || 2} min · ${date}</span>
              </div>
            </div>
            ${cover}
            <div class="card-title">${esc(a.title)}</div>
            <div class="card-desc">${esc(a.excerpt || '')}</div>
            <div class="card-footer">
              <span class="cstat"><span class="cstat-icon">⚡</span>${esc(a.model || 'AI')}</span>
              <div class="card-actions">
                <button class="action-btn read dp-read-btn" data-dpid="${esc(a.id)}">Read Article →</button>
              </div>
            </div>
          </div>`;
      }).join('');

      feedEl.querySelectorAll('.dp-read-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openDevpulseArticle(btn.dataset.dpid); });
      });
      feedEl.querySelectorAll('.article-card').forEach(card => {
        card.addEventListener('click', () => openDevpulseArticle(card.dataset.dpid));
      });
      return;
    }

    // ── Standard feed ──
    let source = allArticles;
    if (activeFilter === 'bookmarks') {
      source = getBookmarks();
    } else if (activeFilter !== 'all') {
      source = allArticles.filter(a => a.source === activeFilter);
    }

    const filtered = source.filter(a => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (a.title || '').toLowerCase().includes(q) ||
             (a.author || a.by || '').toLowerCase().includes(q) ||
             (a.tags || a.tag_list || []).some(t => t.toLowerCase().includes(q));
    });

    if (filtered.length === 0) {
      feedEl.innerHTML = `<div class="feed-notice">
        <div class="feed-notice-title">${activeFilter === 'bookmarks' ? 'Nothing Saved' : 'No Stories Found'}</div>
        <div class="feed-notice-sub">${activeFilter === 'bookmarks' ? 'Bookmark any story to read later' : 'Try a different filter or search query'}</div>
      </div>`;
      return;
    }

    feedEl.innerHTML = filtered.map((a, i) => {
      const cfg    = SOURCE_CFG[a.source] || { label: a.source, cls: '' };
      const id     = a.id || a.url;
      const url    = a.url || a.link || '#';
      const author = a.author || a.by || '';
      const date   = a.time || a.published_at || a.date || '';
      const pts    = a.points || a.score || a.positive_reactions_count || 0;
      const cmnts  = a.comments_count ?? a.descendants ?? 0;
      const tags   = (a.tags || a.tag_list || []).slice(0, 4);
      const booked = isBookmarked(id);

      const coverHtml = a.cover_image
        ? `<div class="card-cover-wrap"><img class="card-cover" src="${esc(a.cover_image)}" alt="" loading="lazy"></div>`
        : '';

      const descHtml = (a.description || a.summary)
        ? `<div class="card-desc">${esc((a.description || a.summary).slice(0, 180))}</div>`
        : '';

      const tagsHtml = tags.length
        ? `<div class="card-tags">${tags.map(t => `<span class="ctag">#${esc(t)}</span>`).join('')}</div>`
        : '';

      // GitHub repos show stars prominently
      const statsHtml = a.source === 'github'
        ? `<span class="cstat"><span class="cstat-icon">★</span>${fmt(pts)}</span>
           ${a.language ? `<span class="cstat"><span class="cstat-icon">◈</span>${esc(a.language)}</span>` : ''}`
        : `<span class="cstat"><span class="cstat-icon">▲</span>${fmt(pts)}</span>
           <span class="cstat"><span class="cstat-icon">💬</span>${fmt(cmnts)}</span>`;

      return `
        <article class="feed-card" data-source="${esc(a.source)}" data-idx="${i}"
                 style="animation-delay:${Math.min(i,10)*40}ms">
          <div class="card-header">
            <div class="card-meta">
              <span class="src-badge ${cfg.cls}">${cfg.label}</span>
              ${author ? `<span class="card-author">${esc(author)}</span>` : ''}
            </div>
            <div class="card-right">
              <span class="card-time">${timeAgo(date)}</span>
              <button class="bkmark-btn ${booked ? 'active' : ''}" data-idx="${i}"
                      title="${booked ? 'Unsave' : 'Save'}">${booked ? '◆' : '◇'}</button>
            </div>
          </div>
          ${coverHtml}
          <div class="card-title">${esc(a.title || 'Untitled')}</div>
          ${tagsHtml}
          ${descHtml}
          <div class="card-footer">
            <div class="card-stats">${statsHtml}</div>
            <div class="card-actions">
              <button class="action-btn summarize-btn"
                      data-title="${esc(a.title)}" data-url="${esc(url)}">✦ Summary</button>
              <button class="action-btn read open-reader-btn" data-idx="${i}">Read →</button>
            </div>
          </div>
        </article>`;
    }).join('');

    // Bind events
    feedEl.querySelectorAll('.bkmark-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        toggleBookmark(filtered[parseInt(btn.dataset.idx)], e);
      });
    });

    feedEl.querySelectorAll('.summarize-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleSummarize(btn.dataset.title, btn.dataset.url);
      });
    });

    feedEl.querySelectorAll('.open-reader-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openArticleReader(filtered[parseInt(btn.dataset.idx)]);
      });
    });

    feedEl.querySelectorAll('.feed-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openArticleReader(filtered[parseInt(card.dataset.idx)]);
      });
    });
  };

  // ─── Search ──────────────────────────────────────
  let searchTimer;
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderFeed, 280);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault(); searchInput.focus(); searchInput.select();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault(); searchInput.focus(); searchInput.select();
    } else if (e.key === 'Escape') {
      if (document.activeElement === searchInput) {
        searchInput.value = ''; searchQuery = ''; searchInput.blur(); renderFeed();
      }
      closeReader();
      closeModal();
    }
  });

  // ─── Nav Filter Buttons ───────────────────────────
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      navBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.source;

      if (activeFilter === 'articles') {
        fetchDevpulseArticles().then(renderFeed);
      } else {
        renderFeed();
      }

      if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('mob-overlay').classList.remove('open');
      }
    });
  });

  // ════════════════════════════════════════════════
  //  ARTICLE READER
  //  Strategy:
  //   1. Dev.to → native API (instant, rich markdown)
  //   2. All others → /api/scrape (fast, real content, ~1-3s)
  //   3. If scrape too short or HN discussion → AI generate (30s, shows generating state)
  //   4. "Generate with AI" button always available for enhancement
  // ════════════════════════════════════════════════

  let readerCurrentArticle = null;

  const openReader = () => {
    readerOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    readerOverlay.scrollTop = 0;
  };

  const closeReader = () => {
    readerOverlay.classList.remove('open');
    document.body.style.overflow = '';
    readerAiBtn.style.display = 'none';
    readerCurrentArticle = null;
  };

  readerClose.addEventListener('click', closeReader);
  readerOverlay.addEventListener('click', (e) => { if (e.target === readerOverlay) closeReader(); });

  const setReaderMeta = (article, model, showAiBtn = false) => {
    const cfg = SOURCE_CFG[article.source] || { label: 'DevPulse', cls: 'dp' };
    readerBadge.textContent = cfg.label.toUpperCase();
    readerTitle.textContent = article.title || '';

    const rawDate = article.generatedAt || article.published_at || article.date || article.time;
    readerDate.textContent = rawDate ? new Date(rawDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

    const origUrl = article.url || article.link || article.sourceUrl || '#';
    readerOrigLink.href = origUrl;

    if (model) {
      readerModel.textContent = `⚡ ${model}`;
      readerModel.parentElement.style.display = '';
    } else {
      readerModel.parentElement.style.display = 'none';
    }

    const cover = article.coverImage || article.cover_image || '';
    if (cover) {
      readerCover.src = cover;
      readerCover.alt = article.title || '';
      readerCoverWrap.style.display = 'block';
    } else {
      readerCoverWrap.style.display = 'none';
    }

    readerAiBtn.style.display = showAiBtn ? 'inline-flex' : 'none';
  };

  const showReaderLoading = (article) => {
    readerTitle.textContent = article.title || 'Loading…';
    readerBadge.textContent = (SOURCE_CFG[article.source]?.label || 'Loading').toUpperCase();
    readerDate.textContent = '';
    readerReadtime.textContent = '';
    readerModel.textContent = '';
    readerModel.parentElement.style.display = 'none';
    readerOrigLink.href = article.url || article.link || '#';
    readerCoverWrap.style.display = 'none';
    readerAiBtn.style.display = 'none';
    readerProse.innerHTML = `
      <div class="reader-skeleton">
        ${Array(7).fill(0).map((_, i) =>
          `<div class="skel-line ${['l','xl','m','l','xl','s','m'][i]}" style="animation-delay:${i*70}ms"></div>`
        ).join('')}
      </div>`;
  };

  const showReaderGenerating = () => {
    readerProse.innerHTML = `
      <div class="reader-generating">
        <div class="gen-spinner"></div>
        <div class="gen-label">Fetching & generating with AI…</div>
        <div class="gen-sub">Reading source page and writing a full article</div>
      </div>`;
  };

  const showReaderContent = (content, readTime, showAiBtn = false, article = null) => {
    readerProse.innerHTML = md(content || '');
    readerReadtime.textContent = readTime ? `${readTime} min read` : '';
    readerAiBtn.style.display = showAiBtn ? 'inline-flex' : 'none';
    if (article) readerCurrentArticle = article;
  };

  const showReaderError = (msg) => {
    readerProse.innerHTML = `<div class="feed-notice">
      <div class="feed-notice-title">Could Not Load</div>
      <div class="feed-notice-sub">${esc(msg)}</div>
      <br><div class="feed-notice-sub">Try the "Source ↗" link above to read the original.</div>
    </div>`;
  };

  // "Generate with AI" button handler
  readerAiBtn.addEventListener('click', async () => {
    if (!readerCurrentArticle) return;
    readerAiBtn.style.display = 'none';
    showReaderGenerating();
    await runAiGeneration(readerCurrentArticle);
  });

  // Run AI generation and display in reader
  const runAiGeneration = async (article) => {
    const url = article.url || article.link || '';
    try {
      const res = await fetch('/api/generate-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:  article.title,
          url,
          source: article.source,
          tags:   article.tags || [],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const merged = { ...article, coverImage: data.coverImage || article.cover_image };
      setReaderMeta(merged, data.model, false);
      showReaderContent(data.content || '', data.readTime, false);
      toast('AI article generated & saved to your library', 'success');
      fetchDevpulseArticles(); // refresh library silently
    } catch (err) {
      showReaderError(err.message);
    }
  };

  /**
   * openArticleReader — opens any article inline.
   *
   * Flow:
   *  Dev.to  → /api/devto?id=…    (native markdown, instant)
   *  Others  → /api/scrape        (real content, no AI needed, ~1-3s)
   *    ├ good content (>120 chars) → show real content + optional AI button
   *    ├ short / partial           → show what we have + AI button
   *    └ complete failure          → show error + Source link + AI button
   *  AI is ALWAYS optional — never auto-called on failure.
   */
  const openArticleReader = async (article) => {
    openReader();
    showReaderLoading(article);
    readerCurrentArticle = article;

    const url = article.url || article.link || '';

    // ── Dev.to: native API ──────────────────────────
    if (article.source === 'devto') {
      try {
        const res = await fetch(`/api/devto?id=${article.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const merged = { ...article, coverImage: data.coverImage || article.cover_image };
        setReaderMeta(merged, 'dev.to native', true);
        showReaderContent(data.content || data.body_markdown || '', data.readTime, true, article);
        return;
      } catch (err) {
        console.warn('Dev.to native failed, falling back to scrape:', err.message);
      }
    }

    // ── HN discussion page (Ask HN / Show HN) ───────
    // These are comment threads, not article pages — scrape won't yield article text.
    // Offer AI but don't auto-call it.
    const isHNDiscussion = url.includes('news.ycombinator.com/item');
    if (isHNDiscussion) {
      setReaderMeta(article, null, true);
      readerProse.innerHTML = `
        <div class="feed-notice">
          <div class="feed-notice-title">HN Discussion Thread</div>
          <div class="feed-notice-sub">
            This is a HackerNews discussion page — there's no article body to extract.<br><br>
            Click <strong>Source ↗</strong> above to read the comments, or use
            <strong>✦ Generate AI Article</strong> to get an AI-written deep-dive on this topic.
          </div>
        </div>`;
      readerReadtime.textContent = '';
      return;
    }

    // ── All sources: fast scrape first ──────────────
    let scraped = null;
    try {
      const res = await fetch(`/api/scrape?url=${encodeURIComponent(url)}`);
      if (res.ok) scraped = await res.json();
    } catch (err) {
      console.warn('Scrape request failed:', err.message);
    }

    // Good content — show immediately
    if (scraped && scraped.content && scraped.content.length > 120) {
      const merged = { ...article, coverImage: scraped.coverImage || article.cover_image || '' };
      setReaderMeta(merged, 'Live content', true);
      showReaderContent(scraped.content, scraped.readTime, true, article);
      return;
    }

    // Partial content — show what we have with a note
    if (scraped && scraped.content && scraped.content.length > 0) {
      const merged = { ...article, coverImage: scraped.coverImage || article.cover_image || '' };
      setReaderMeta(merged, 'Partial content', true);
      const note = `> *Limited content extracted — the page may require JavaScript or be behind a paywall.*\n\n`;
      showReaderContent(note + scraped.content, scraped.readTime || 1, true, article);
      return;
    }

    // Complete scrape failure — show helpful error, offer AI
    const fallbackText = article.description || article.summary || '';
    if (fallbackText && fallbackText.length > 20) {
      setReaderMeta(article, 'Feed excerpt', true);
      showReaderContent(`> *Source page could not be fully extracted, so DevPulse is showing the feed excerpt.*\n\n${fallbackText}`, 1, true, article);
      return;
    }

    setReaderMeta(article, null, true);
    readerProse.innerHTML = `
      <div class="feed-notice">
        <div class="feed-notice-title">Could Not Extract Content</div>
        <div class="feed-notice-sub">
          The page could not be scraped (may require JavaScript, login, or block bots).<br><br>
          Try <strong>Source ↗</strong> to read the original, or click
          <strong>✦ Generate AI Article</strong> to get an AI-written summary.
        </div>
      </div>`;
    readerReadtime.textContent = '';
  };

  /** Open a saved DevPulse Original by ID */
  const openDevpulseArticle = async (id) => {
    const stub = devpulseArticles.find(a => a.id === id) || { title: 'Loading…', source: 'devpulse' };
    openReader();
    showReaderLoading(stub);

    try {
      const res = await fetch(`/api/articles?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const art = { ...data, url: data.sourceUrl };
      setReaderMeta(art, data.model, false);
      showReaderContent(data.content || '', data.readTime, false);
    } catch (err) {
      showReaderError(err.message);
    }
  };

  // ════════════════════════════════════════════════
  //  AI SUMMARY MODAL
  // ════════════════════════════════════════════════
  const openModal = (title) => {
    smTitle.textContent = title;
    smBody.innerHTML = `<div class="dots-loader"><span></span><span></span><span></span></div>`;
    smModel.textContent = '';
    modalVeil.classList.add('open');
  };

  const closeModal = () => modalVeil.classList.remove('open');

  smClose.addEventListener('click', closeModal);
  modalVeil.addEventListener('click', (e) => { if (e.target === modalVeil) closeModal(); });

  const handleSummarize = async (title, url) => {
    openModal(title);

    const key = `sum:${title}`;
    const cached = cacheGet(key, SUMMARY_TTL);
    if (cached) {
      smBody.innerHTML = fmtSummary(cached.text);
      smModel.textContent = cached.model ? `⚡ ${cached.model}` : '';
      return;
    }

    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, url, mode: 'summarize' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = data.summary || 'No summary returned.';
      cacheSet(key, { text, model: data.model || '' });
      smBody.innerHTML = fmtSummary(text);
      smModel.textContent = data.model ? `⚡ ${data.model}` : '';
    } catch (err) {
      smBody.innerHTML = `<div class="feed-notice-sub">Could not generate summary. Please try again.</div>`;
    }
  };

  const fmtSummary = (text) =>
    text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

  // ════════════════════════════════════════════════
  //  AI STATUS
  // ════════════════════════════════════════════════
  const updateStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();
      if (data.model && statusText) {
        statusText.textContent = `${data.model} (${data.configuredGeminiKeys}k)`;
      }
    } catch {}
  };

  // ════════════════════════════════════════════════
  //  CHAT WIDGET
  // ════════════════════════════════════════════════
  const initChat = () => {
    const fab      = document.getElementById('chat-fab');
    const drawer   = document.getElementById('chat-drawer');
    const closeBtn = document.getElementById('chat-close');
    const input    = document.getElementById('chat-input');
    const sendBtn  = document.getElementById('chat-send');
    const messages = document.getElementById('chat-messages');
    const quickBtns= document.querySelectorAll('.quick-btn');
    let busy = false;

    const openChat   = () => { drawer.classList.add('open'); input.focus(); notifBadge.style.display = 'none'; };
    const closeChatW = () => drawer.classList.remove('open');

    fab.addEventListener('click', () => drawer.classList.contains('open') ? closeChatW() : openChat());
    closeBtn.addEventListener('click', closeChatW);

    const addBubble = (text, who) => {
      const div = document.createElement('div');
      div.className = `chat-bubble ${who}`;
      div.innerHTML = who === 'ai' ? md(text) : esc(text);
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    };

    const addTyping = () => {
      const div = document.createElement('div');
      div.className = 'chat-bubble ai';
      div.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    };

    const getCtx = () => {
      const headlines = allArticles.slice(0, 15).map(a => `- ${a.title} (${a.source})`).join('\n');
      const ghRepos = allArticles.filter(a => a.source === 'github').slice(0, 5).map(a => `- ${a.title}`).join('\n');
      return headlines || 'No headlines loaded yet.';
    };

    const send = async (text) => {
      text = (text || input.value).trim();
      if (!text || busy) return;
      input.value = '';
      busy = true;
      addBubble(text, 'user');
      const typing = addTyping();

      try {
        const res = await fetch('/api/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: text, content: getCtx(), mode: 'chat' }),
        });
        typing.remove();
        busy = false;
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        addBubble(data.summary || 'No response.', 'ai');
      } catch {
        typing.remove();
        busy = false;
        addBubble('DevPulse AI is temporarily unavailable. Please try again.', 'ai');
      }
    };

    sendBtn.addEventListener('click', () => send());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    quickBtns.forEach(b => b.addEventListener('click', () => send(b.dataset.query)));
  };

  // ════════════════════════════════════════════════
  //  MOBILE SIDEBAR
  // ════════════════════════════════════════════════
  const initMobileSidebar = () => {
    const menuBtn = document.getElementById('mob-menu-btn');
    const overlay = document.getElementById('mob-overlay');
    const sidebar = document.getElementById('sidebar');

    menuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('open');
    });
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
    });
  };

  // ════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════
  const init = () => {
    applyTheme(themeMode);
    fetchAll();
    updateStatus();
    setInterval(fetchAll, REFRESH_MS);
    initChat();
    initMobileSidebar();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
