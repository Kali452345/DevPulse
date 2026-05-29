/* ══════════════════════════════════════════════════
   DevPulse — Vanilla JS Application
   ══════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─── DOM References ───
  const feedEl = document.getElementById('feed');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalModel = document.getElementById('modal-model');
  const modalClose = document.getElementById('modal-close');
  const modelStatus = document.getElementById('model-status');
  const toastContainer = document.getElementById('toast-container');
  const filterBtns = document.querySelectorAll('.filter-btn');

  // NEW DOM References
  const searchInput = document.getElementById('search-input');
  const themeBtn = document.getElementById('theme-btn');
  const notificationBtn = document.getElementById('notification-btn');
  const notificationBadge = document.getElementById('notification-badge');
  const dashboardBody = document.getElementById('dashboard-body');

  const articleModalOverlay = document.getElementById('article-modal-overlay');
  const articleModalClose = document.getElementById('article-modal-close');
  const articleCover = document.getElementById('article-cover');
  const articleCoverContainer = document.getElementById('article-cover-container');
  const articleSourceBadge = document.getElementById('article-source-badge');
  const articleReadtime = document.getElementById('article-readtime');
  const articleDate = document.getElementById('article-date');
  const articleReaderTitle = document.getElementById('article-reader-title');
  const articleReaderBody = document.getElementById('article-reader-body');
  const articleSourceLink = document.getElementById('article-source-link');
  const articleModelBadge = document.getElementById('article-model-badge');

  // ─── State ───
  let allArticles = []; // News feed articles
  let devpulseArticles = []; // AI written articles loaded from backend Netlify Blobs
  let activeFilter = 'all';
  let searchQuery = '';
  let themeMode = localStorage.getItem('devpulse-theme') || 'dark'; // dark, light, system
  let notificationsEnabled = localStorage.getItem('devpulse-notifications') === 'true';

  const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const SUMMARY_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  const TREND_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  // ═══════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════

  const timeAgo = (dateString) => {
    if (!dateString) return '';
    const now = Date.now();
    const then = new Date(dateString).getTime();
    const diff = now - then;
    if (diff < 0) return 'just now';

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  };

  const formatNumber = (n) => {
    if (n == null) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  const getFromCache = (key, maxAgeMs) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.timestamp > maxAgeMs) {
        localStorage.removeItem(key);
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  };

  const setCache = (key, data) => {
    try {
      localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch {}
  };

  const todayKey = () => new Date().toISOString().slice(0, 10);

  // Simple Markdown Parser to render generated articles cleanly
  const parseMarkdown = (markdown) => {
    if (!markdown) return '';
    let html = markdown;

    // Convert code blocks ```js ... ```
    html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
      return `<pre><code>${code.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
    });

    // Convert inline code `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Convert headers ## Heading
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');

    // Convert lists
    html = html.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> tags in <ul>
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    // Clean up double ul tags
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    // Convert bold **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Convert italics *text*
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Convert paragraphs (split by double newline, wrapping non-HTML lines)
    const paragraphs = html.split(/\n{2,}/);
    html = paragraphs.map(p => {
      p = p.trim();
      if (!p) return '';
      if (p.startsWith('<h') || p.startsWith('<pre') || p.startsWith('<ul') || p.startsWith('<ol')) {
        return p;
      }
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    return html;
  };

  // ═══════════════════════════════════════════════
  //  TOAST NOTIFICATIONS
  // ═══════════════════════════════════════════════

  const showToast = (message, type = 'error') => {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  };

  // ═══════════════════════════════════════════════
  //  THEME MANAGER
  // ═══════════════════════════════════════════════

  const applyTheme = (theme) => {
    const root = document.documentElement;
    const themeIcon = themeBtn.querySelector('.btn-icon');

    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
      themeIcon.textContent = '☀️';
    } else if (theme === 'dark') {
      root.removeAttribute('data-theme');
      themeIcon.textContent = '🌙';
    } else {
      // System
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (isDark) {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', 'light');
      }
      themeIcon.textContent = '💻';
    }
  };

  themeBtn.addEventListener('click', () => {
    if (themeMode === 'dark') {
      themeMode = 'light';
    } else if (themeMode === 'light') {
      themeMode = 'system';
    } else {
      themeMode = 'dark';
    }
    localStorage.setItem('devpulse-theme', themeMode);
    applyTheme(themeMode);
    showToast(`Theme switched to: ${themeMode}`, 'success');
  });

  // Listen to system theme changes if set to system
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'system') {
      applyTheme('system');
    }
  });

  // ═══════════════════════════════════════════════
  //  BOOKMARKS MANAGER
  // ═══════════════════════════════════════════════

  const getBookmarks = () => {
    try {
      return JSON.parse(localStorage.getItem('devpulse-bookmarks')) || [];
    } catch {
      return [];
    }
  };

  const isBookmarked = (articleId) => {
    const bookmarks = getBookmarks();
    return bookmarks.some(b => b.id === articleId || b.url === articleId);
  };

  const toggleBookmark = (article, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    let bookmarks = getBookmarks();
    const id = article.id || article.url;

    if (isBookmarked(id)) {
      bookmarks = bookmarks.filter(b => b.id !== id && b.url !== id);
      localStorage.setItem('devpulse-bookmarks', JSON.stringify(bookmarks));
      showToast('Removed from Saved bookmarks', 'success');
    } else {
      bookmarks.push(article);
      localStorage.setItem('devpulse-bookmarks', JSON.stringify(bookmarks));
      showToast('Saved to Bookmarks', 'success');
    }

    // Refresh UI
    if (activeFilter === 'bookmarks') {
      renderFeed();
    } else {
      // Re-render current feed to update icons
      renderFeed();
    }
  };

  // ═══════════════════════════════════════════════
  //  DESKTOP NOTIFICATIONS
  // ═══════════════════════════════════════════════

  const checkNotificationPermission = async () => {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    }
    return false;
  };

  notificationBtn.addEventListener('click', async () => {
    notificationsEnabled = !notificationsEnabled;
    localStorage.setItem('devpulse-notifications', notificationsEnabled);

    if (notificationsEnabled) {
      const allowed = await checkNotificationPermission();
      if (allowed) {
        showToast('Desktop notifications enabled!', 'success');
        notificationBtn.querySelector('.btn-icon').textContent = '🔔';
        notificationBadge.style.display = 'none';
      } else {
        notificationsEnabled = false;
        localStorage.setItem('devpulse-notifications', 'false');
        showToast('Notification permission denied by browser.');
      }
    } else {
      showToast('Notifications disabled.');
      notificationBtn.querySelector('.btn-icon').textContent = '🔕';
      notificationBadge.style.display = 'none';
    }
  });

  const triggerDesktopNotification = (title, body, url) => {
    if (!notificationsEnabled || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(`⚡ DevPulse Breaking: ${title}`, {
        body: body,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚡</text></svg>'
      });
      n.onclick = () => {
        window.open(url, '_blank');
        n.close();
      };
    } catch (e) {
      console.warn("Desktop notifications not supported in this environment:", e);
    }
  };

  const scanForBreakingNews = (articles) => {
    const notified = JSON.parse(localStorage.getItem('devpulse-notified-ids')) || [];
    let foundNewBreaking = false;

    articles.forEach(art => {
      const id = art.id || art.url;
      const points = art.points || art.score || art.positive_reactions_count || 0;

      // Breaking if HN has > 400 points or Dev.to has > 150 likes
      const isHnBreaking = art.source === 'hackernews' && points > 400;
      const isDevToBreaking = art.source === 'devto' && points > 150;

      if ((isHnBreaking || isDevToBreaking) && !notified.includes(id)) {
        notified.push(id);
        triggerDesktopNotification(art.title, `Viral on ${art.source} with ${points} points! Read now.`, art.url || art.link);
        foundNewBreaking = true;
      }
    });

    localStorage.setItem('devpulse-notified-ids', JSON.stringify(notified));

    if (foundNewBreaking && !notificationsEnabled) {
      notificationBadge.style.display = 'block';
    }
  };

  // ═══════════════════════════════════════════════
  //  SKELETON LOADER
  // ═══════════════════════════════════════════════

  const renderSkeletons = (count = 6) => {
    feedEl.innerHTML = Array.from({ length: count }, () => `
      <div class="skeleton-card">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line long"></div>
        <div class="skeleton-line medium"></div>
        <div class="skeleton-line xshort"></div>
      </div>
    `).join('');
  };

  // ═══════════════════════════════════════════════
  //  FEED FETCHING
  // ═══════════════════════════════════════════════

  const fetchFeed = async (endpoint, source) => {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.articles || data || []).map((a) => ({ ...a, source }));
    } catch (err) {
      console.warn(`Failed to fetch ${source}:`, err);
      showToast(`Unable to load ${source}`);
      return [];
    }
  };

  const fetchArticles = async () => {
    try {
      const res = await fetch('/api/articles');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      devpulseArticles = data.articles || [];
    } catch (err) {
      console.warn('Failed to load DevPulse articles from Netlify Blobs:', err);
      showToast('Unable to load premium generated articles');
    }
  };

  const fetchAllFeeds = async () => {
    renderSkeletons();

    const [devto, ai] = await Promise.all([
      fetchFeed('/api/devto', 'devto'),
      fetchFeed('/api/ai-news', 'ai-news'),
      fetchArticles() // Pre-fetch DevPulse Original articles in background
    ]);

    allArticles = [...devto, ...ai].sort((a, b) => {
      const tA = new Date(a.time || a.published_at || a.date || 0).getTime();
      const tB = new Date(b.time || b.published_at || b.date || 0).getTime();
      return tB - tA;
    });

    scanForBreakingNews(allArticles);
    renderFeed();
    renderDashboardStats(); // Auto-update dashboard right panel
  };

  // ═══════════════════════════════════════════════
  //  CARD RENDERING
  // ═══════════════════════════════════════════════

  const sourceConfig = {
    devto: { label: 'Dev.to', cssClass: 'devto' },
    'ai-news': { label: 'TensorFeed', cssClass: 'ai' },
  };

  const renderFeed = () => {
    feedEl.innerHTML = '';

    // A. DEVPULSE PREMIUM ARTICLES VIEW
    if (activeFilter === 'articles') {
      const filtered = devpulseArticles.filter(art => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return art.title.toLowerCase().includes(q) ||
               art.excerpt.toLowerCase().includes(q) ||
               (art.tags && art.tags.some(t => t.toLowerCase().includes(q)));
      });

      if (filtered.length === 0) {
        feedEl.innerHTML = `<div class="feed-error">No premium generated articles found. Search matches nothing or none have been generated yet!</div>`;
        return;
      }

      feedEl.innerHTML = filtered.map((article, i) => {
        const coverImg = article.coverImage
          ? `<img class="article-card-cover" src="${article.coverImage}" alt="${article.title}" loading="lazy">`
          : `<div class="article-card-placeholder">📝</div>`;

        const dateStr = article.generatedAt ? new Date(article.generatedAt).toLocaleDateString() : '';

        return `
          <div class="article-card" style="animation-delay:${i * 50}ms">
            <div class="article-card-cover-container">
              ${coverImg}
            </div>
            <div class="article-card-body">
              <div>
                <div class="article-card-meta">
                  <span class="article-original-badge">DevPulse Original</span>
                  <span>${article.readTime || 2} min read • ${dateStr}</span>
                </div>
                <h3 class="article-card-title">${article.title}</h3>
                <p class="article-card-excerpt">${article.excerpt}</p>
              </div>
              <div class="article-card-bottom">
                <button class="btn btn-trend read-article-btn" data-id="${article.id}">
                  📖 Read Full Article
                </button>
                <span class="model-badge">⚡ ${article.model || 'gemini-2.5-flash'}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      // Attach article reading click handlers
      feedEl.querySelectorAll('.read-article-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          openArticleReader(id);
        });
      });

      return;
    }

    // B. BOOKMARKS/SAVED VIEW
    let feedSource = allArticles;
    if (activeFilter === 'bookmarks') {
      feedSource = getBookmarks();
    } else if (activeFilter !== 'all') {
      feedSource = allArticles.filter((a) => a.source === activeFilter);
    }

    // Apply Search Query filtering
    const filtered = feedSource.filter(art => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const titleMatch = (art.title || '').toLowerCase().includes(q);
      const authorMatch = (art.author || art.by || '').toLowerCase().includes(q);
      const tagMatch = art.tags && art.tags.some(t => t.toLowerCase().includes(q));
      return titleMatch || authorMatch || tagMatch;
    });

    if (filtered.length === 0) {
      feedEl.innerHTML = `<div class="feed-error">No articles found matching your query. Try clearing your search or filter.</div>`;
      return;
    }

    feedEl.innerHTML = filtered.map((article, i) => {
      const src = sourceConfig[article.source] || { label: article.source, cssClass: '' };
      const title = article.title || 'Untitled';
      const url = article.url || article.link || '#';
      const author = article.author || article.by || article.user?.name || '';
      const dateStr = article.time || article.published_at || article.date || '';
      const points = article.points || article.score || article.positive_reactions_count || 0;
      const comments = article.comments_count ?? article.descendants ?? article.num_comments ?? 0;
      const tags = article.tags || article.tag_list || [];
      const artId = article.id || article.url;

      const tagsHtml = Array.isArray(tags) && tags.length
        ? `<div class="card-tags">${tags.slice(0, 4).map((t) => `<span class="tag">#${t}</span>`).join('')}</div>`
        : '';

      const isBooked = isBookmarked(artId);

      const coverImgHtml = article.cover_image
        ? `<div class="feed-card-cover-container">
             <img class="feed-card-cover" src="${article.cover_image}" alt="${title}" loading="lazy">
           </div>`
        : '';

      const descHtml = (article.description || article.summary)
        ? `<p class="feed-card-description">${article.description || article.summary}</p>`
        : '';

      return `
        <article class="feed-card" data-source="${article.source}" style="animation-delay:${i * 50}ms">
          <div class="card-top">
            <div class="card-meta-left">
              <span class="source-badge ${src.cssClass}">${src.label}</span>
              ${author ? `<span class="card-author">by <strong>${author}</strong></span>` : ''}
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="card-time">${timeAgo(dateStr)}</span>
              <button class="bookmark-btn ${isBooked ? 'active' : ''}" data-index="${i}" title="${isBooked ? 'Unsave Bookmark' : 'Save Bookmark'}">
                ${isBooked ? '🔖' : 'bookmark_border'}
              </button>
            </div>
          </div>
          ${coverImgHtml}
          <h2 class="card-title">${title}</h2>
          ${tagsHtml}
          ${descHtml}
          <div class="card-bottom">
            <div class="card-stats">
              <span class="stat"><span class="stat-icon">▲</span> ${formatNumber(points)}</span>
              <span class="stat"><span class="stat-icon">💬</span> ${formatNumber(comments)}</span>
            </div>
            <div style="display:flex; gap:8px;">
              <button class="btn-summarize" data-title="${title.replace(/"/g, '&quot;')}" data-url="${url}">
                <span class="sparkle">✨</span> Summarize
              </button>
              ${article.source === 'devto' 
                ? `<button class="btn btn-trend read-devto-btn" data-id="${article.id}">
                     📖 Read Article
                   </button>` 
                : ''
              }
            </div>
          </div>
        </article>`;
    }).join('');

    // Attach summarize, read-devto, and bookmarks click listeners
    feedEl.querySelectorAll('.btn-summarize').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-title');
        const u = btn.getAttribute('data-url');
        handleSummarize(t, u);
      });
    });

    feedEl.querySelectorAll('.read-devto-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openArticleReader(id, true);
      });
    });

    feedEl.querySelectorAll('.bookmark-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        const article = filtered[idx];
        toggleBookmark(article, e);
      });
    });
  };

  // ─── Search input real-time handler ───
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderFeed();
  });

  // Short-cut handlers (Ctrl+K or '/' to focus search)
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === 'Escape' && document.activeElement === searchInput) {
      searchInput.value = '';
      searchQuery = '';
      searchInput.blur();
      renderFeed();
    }
  });

  // ═══════════════════════════════════════════════
  //  FILTER BUTTONS
  // ═══════════════════════════════════════════════

  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.source;

      if (activeFilter === 'articles') {
        fetchArticles().then(renderFeed);
      } else {
        renderFeed();
      }
    });
  });

  // ═══════════════════════════════════════════════
  //  MODALS OPEN & CLOSE
  // ═══════════════════════════════════════════════

  const openModal = (title = 'AI Summary') => {
    modalTitle.textContent = title;
    modalBody.innerHTML = `<div class="loading-dots"><span></span><span></span><span></span></div>`;
    modalModel.textContent = '';
    modalOverlay.classList.add('open');
  };

  const closeModal = () => {
    modalOverlay.classList.remove('open');
  };

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Article Reader Modal triggers
  const openArticleModal = () => {
    articleReaderBody.innerHTML = `<div class="loading-dots"><span></span><span></span><span></span></div>`;
    articleModalOverlay.classList.add('open');
  };

  const closeArticleModal = () => {
    articleModalOverlay.classList.remove('open');
  };

  articleModalClose.addEventListener('click', closeArticleModal);
  articleModalOverlay.addEventListener('click', (e) => {
    if (e.target === articleModalOverlay) closeArticleModal();
  });

  // Global keydown listeners for escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeArticleModal();
    }
  });

  const showModalContent = (html, model = '') => {
    modalBody.innerHTML = html;
    if (model) {
      modalModel.textContent = `⚡ ${model}`;
      const label = modelStatus.querySelector('.status-label');
      if (label) label.textContent = model;
    }
  };

  const showModalError = (msg) => {
    modalBody.innerHTML = `<div class="feed-error">${msg}</div>`;
  };

  // ═══════════════════════════════════════════════
  //  SUMMARIZE
  // ═══════════════════════════════════════════════

  const handleSummarize = async (title, url) => {
    openModal(title);

    const cacheKey = `summary_${title}`;
    const cached = getFromCache(cacheKey, SUMMARY_CACHE_TTL);
    if (cached) {
      showModalContent(formatSummary(cached.summary), cached.model);
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
      const summary = data.summary || data.text || data.result || 'No summary returned.';
      const model = data.model || 'gemini-2.5-flash';

      setCache(cacheKey, { summary, model });
      showModalContent(formatSummary(summary), model);
    } catch (err) {
      console.error('Summarize error:', err);
      showModalError('Unable to generate summary. The AI service might be temporarily unavailable — please try again later.');
    }
  };

  const formatSummary = (text) => {
    return text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  };

  // ═══════════════════════════════════════════════
  //  GENERATE ARTICLE (Backend Netlify Blobs storage)
  // ═══════════════════════════════════════════════

  const handleGenerate = async (title, url, source, tags, buttonEl) => {
    showToast('AI is writing an original premium article... Please wait.', 'success');
    buttonEl.classList.add('generating');
    buttonEl.innerHTML = `<span class="sparkle">⏳</span> Writing...`;

    try {
      const res = await fetch('/api/generate-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, url, source, tags })
      });

      buttonEl.classList.remove('generating');
      buttonEl.innerHTML = `<span class="sparkle">✍️</span> Generate Article`;

      if (!res.ok) throw new Error(`HTTP error ${res.status}`);

      const article = await res.json();
      showToast('Article generated successfully and saved to storage!', 'success');

      // Refresh articles array
      await fetchArticles();

      // If user is on DevPulse Articles tab, re-render immediately
      if (activeFilter === 'articles') {
        renderFeed();
      } else {
        // Toggle view to the Articles tab so the user sees it immediately
        const artBtn = Array.from(filterBtns).find(btn => btn.dataset.source === 'articles');
        if (artBtn) {
          artBtn.click();
        }
      }

    } catch (err) {
      console.error('Generate Article error:', err);
      buttonEl.classList.remove('generating');
      buttonEl.innerHTML = `<span class="sparkle">✍️</span> Generate Article`;
      showToast('Failed to auto-write article. AI studio limit reached.');
    }
  };

  // Fetch and display full article details in Reader Modal
  const openArticleReader = async (articleId, isDevTo = false) => {
    openArticleModal();

    try {
      const endpoint = isDevTo ? `/api/devto?id=${articleId}` : `/api/articles?id=${articleId}`;
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const article = await res.json();

      // Show cover image if it exists, otherwise hide container
      if (article.coverImage) {
        articleCover.src = article.coverImage;
        articleCover.style.display = 'block';
        articleCoverContainer.style.display = 'block';
      } else {
        articleCover.style.display = 'none';
        articleCoverContainer.style.display = 'none';
      }

      articleSourceBadge.textContent = (article.source || 'DevPulse').toUpperCase();
      articleSourceBadge.className = `source-badge ${article.source || 'hn'}`;
      articleReadtime.textContent = `⚡ ${article.readTime || 3} min read`;
      articleDate.textContent = article.generatedAt ? new Date(article.generatedAt).toLocaleDateString() : '';
      articleReaderTitle.textContent = article.title;

      // Parse Markdown body to HTML
      articleReaderBody.innerHTML = parseMarkdown(article.content);

      articleSourceLink.href = article.sourceUrl || '#';
      articleModelBadge.textContent = `Model: ${article.model || 'gemini-2.5-flash'}`;

    } catch (err) {
      console.error('Failed to load full article:', err);
      articleReaderBody.innerHTML = `<div class="feed-error">Could not fetch article details. Try again.</div>`;
    }
  };

  // ═══════════════════════════════════════════════
  //  RIGHT PANEL DASHBOARD RENDERER
  // ═══════════════════════════════════════════════
  
  const renderDashboardStats = () => {
    if (!dashboardBody) return;
    
    const devtoCount = allArticles.filter(a => a.source === 'devto').length;
    const aiCount = allArticles.filter(a => a.source === 'ai-news').length;
    const generatedCount = devpulseArticles.length;
    const bookmarkCount = getBookmarks().length;
    const totalFeedCount = allArticles.length;

    // Aggregate tags
    const tagCounts = {};
    allArticles.forEach(a => {
      const tags = a.tags || a.tag_list || [];
      tags.forEach(tag => {
        const clean = tag.toLowerCase().trim();
        tagCounts[clean] = (tagCounts[clean] || 0) + 1;
      });
    });

    // Sort tags
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    // Calculate source percentages
    const maxVal = Math.max(devtoCount, aiCount, 1);
    const devtoPct = Math.round((devtoCount / maxVal) * 100);
    const aiPct = Math.round((aiCount / maxVal) * 100);

    dashboardBody.innerHTML = \`
      <div class="db-grid">
        <div class="db-card">
          <div class="db-card-val">\${totalFeedCount}</div>
          <div class="db-card-lbl">Feed Stories</div>
        </div>
        <div class="db-card">
          <div class="db-card-val">\${generatedCount}</div>
          <div class="db-card-lbl">AI Originals</div>
        </div>
        <div class="db-card">
          <div class="db-card-val">\${bookmarkCount}</div>
          <div class="db-card-lbl">Bookmarked</div>
        </div>
      </div>

      <div class="db-section">
        <h4>📦 Feed Sources Density</h4>

        <div class="db-bar-item">
          <div class="db-bar-lbls">
            <span>Dev.to articles</span>
            <span>\${devtoCount} stories</span>
          </div>
          <div class="db-bar-track">
            <div class="db-bar-fill" style="width: \${devtoPct}%; background: var(--accent-purple);"></div>
          </div>
        </div>

        <div class="db-bar-item">
          <div class="db-bar-lbls">
            <span>TensorFeed AI news</span>
            <span>\${aiCount} stories</span>
          </div>
          <div class="db-bar-track">
            <div class="db-bar-fill" style="width: \${aiPct}%; background: var(--accent-pink);"></div>
          </div>
        </div>
      </div>

      <div class="db-section">
        <h4>🏷️ Trending Topics Cloud</h4>
        <div class="db-tags-cloud">
          \${topTags.length > 0
            ? topTags.map(([tag, count]) => \`<span class="db-tag">#\${tag} (\${count})</span>\`).join('')
            : '<span class="card-time">No trending tags detected yet.</span>'
          }
        </div>
      </div>

      <div class="db-section">
        <h4>⚡ AI Engine Pool Health</h4>
        <p style="font-size: 13px; color: var(--text-secondary);">
          Currently executing with automatic **Multi-Key Gemini Rotator** (failover to Groq Llama 3.3).
          Models in rotation pool: gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro, llama-3.3-70b.
        </p>
      </div>
    \`;
  };



  // ═══════════════════════════════════════════════
  //  MODEL STATUS
  // ═══════════════════════════════════════════════

  const updateModelStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();
      const label = modelStatus.querySelector('.status-label');
      if (data.model && label) {
        label.textContent = `${data.model} (${data.configuredGeminiKeys} keys)`;
      }
    } catch {}
  };

  // ═══════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════

  const init = () => {
    applyTheme(themeMode);
    
    // Set notification button bell status
    if (notificationsEnabled) {
      notificationBtn.querySelector('.btn-icon').textContent = '🔔';
    } else {
      notificationBtn.querySelector('.btn-icon').textContent = '🔕';
    }

    fetchAllFeeds();
    updateModelStatus();

    // Register service worker for PWA offline utility
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then(reg => console.log('DevPulse ServiceWorker registered with scope:', reg.scope))
          .catch(err => console.warn('DevPulse ServiceWorker registration failed:', err));
      });
    }

    // Auto-refresh
    setInterval(() => {
      fetchAllFeeds();
    }, REFRESH_INTERVAL);

    // Initialize AI Chat Widget
    initChatWidget();
  };

  // ═══════════════════════════════════════════════
  //  AI CHAT WIDGET CONTROLLER
  // ═══════════════════════════════════════════════

  const initChatWidget = () => {
    const toggleBtn = document.getElementById('chat-toggle-btn');
    const widget = document.getElementById('chat-widget');
    const closeBtn = document.getElementById('chat-close-btn');
    const sendBtn = document.getElementById('chat-send-btn');
    const inputField = document.getElementById('chat-input-field');
    const msgsContainer = document.getElementById('chat-messages-container');
    const quickBtns = document.querySelectorAll('.quick-q-btn');

    let isTyping = false;

    const toggleChat = () => {
      widget.classList.toggle('open');
      if (widget.classList.contains('open')) {
        inputField.focus();
        // Clear notifications badge if opened
        notificationBadge.style.display = 'none';
      }
    };

    toggleBtn.addEventListener('click', toggleChat);
    closeBtn.addEventListener('click', () => widget.classList.remove('open'));

    // Gathers currently visible feed headline titles for rich technical context
    const getChatContext = () => {
      if (allArticles.length === 0) return 'No news headlines loaded yet.';
      return allArticles
        .slice(0, 10)
        .map(art => `- ${art.title} (${art.source})`)
        .join('\n');
    };

    const appendMessage = (text, sender = 'ai') => {
      const msg = document.createElement('div');
      msg.className = `chat-msg ${sender}`;
      
      if (sender === 'ai') {
        // AI responses are formatted in Markdown, parse it!
        msg.innerHTML = parseMarkdown(text);
      } else {
        msg.textContent = text;
      }
      
      msgsContainer.appendChild(msg);
      msgsContainer.scrollTop = msgsContainer.scrollHeight;
      return msg;
    };

    const appendTypingIndicator = () => {
      const msg = document.createElement('div');
      msg.className = 'chat-msg ai typing-indicator-msg';
      msg.innerHTML = `
        <div class="chat-typing-dots">
          <span></span><span></span><span></span>
        </div>
      `;
      msgsContainer.appendChild(msg);
      msgsContainer.scrollTop = msgsContainer.scrollHeight;
      return msg;
    };

    const handleSendMessage = async (textVal) => {
      const text = (textVal || inputField.value).trim();
      if (!text || isTyping) return;

      // Clear input
      inputField.value = '';
      isTyping = true;

      // Append User message bubble
      appendMessage(text, 'user');

      // Append AI Typing indicator bubble
      const indicator = appendTypingIndicator();

      try {
        const context = getChatContext();
        const res = await fetch('/api/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: text,
            content: context,
            mode: 'chat'
          })
        });

        indicator.remove();
        isTyping = false;

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        
        const answer = data.summary || data.text || 'Unable to retrieve response.';
        appendMessage(answer, 'ai');

      } catch (err) {
        console.error('Chat error:', err);
        indicator.remove();
        isTyping = false;
        appendMessage('DevPulse AI is currently resting. Please try again in a few moments!', 'ai');
      }
    };

    sendBtn.addEventListener('click', () => handleSendMessage());
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSendMessage();
      }
    });

    // Quick starter questions triggers
    quickBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const query = btn.getAttribute('data-query');
        handleSendMessage(query);
      });
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
