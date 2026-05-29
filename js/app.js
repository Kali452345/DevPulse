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
  const trendBtn = document.getElementById('trend-btn');
  const modelStatus = document.getElementById('model-status');
  const toastContainer = document.getElementById('toast-container');
  const filterBtns = document.querySelectorAll('.filter-btn');

  // ─── State ───
  let allArticles = [];
  let activeFilter = 'all';
  const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const SUMMARY_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  const TREND_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  // ═══════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════

  /** Convert ISO date string to relative time (e.g. '2h ago') */
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

  /** Format large numbers (e.g. 1500 → '1.5k') */
  const formatNumber = (n) => {
    if (n == null) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  /** Get from localStorage with TTL check */
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

  /** Store data with timestamp in localStorage */
  const setCache = (key, data) => {
    try {
      localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch {
      // Storage full — silently fail
    }
  };

  /** Get today's date as YYYY-MM-DD */
  const todayKey = () => new Date().toISOString().slice(0, 10);

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
      // Normalise: ensure each article has a .source field
      return (data.articles || data || []).map((a) => ({ ...a, source }));
    } catch (err) {
      console.warn(`Failed to fetch ${source}:`, err);
      showToast(`Unable to load ${source}`);
      return [];
    }
  };

  const fetchAllFeeds = async () => {
    renderSkeletons();

    const [hn, devto, ai] = await Promise.all([
      fetchFeed('/api/hn', 'hackernews'),
      fetchFeed('/api/devto', 'devto'),
      fetchFeed('/api/ai-news', 'ai-news'),
    ]);

    allArticles = [...hn, ...devto, ...ai].sort((a, b) => {
      const tA = new Date(a.time || a.published_at || a.date || 0).getTime();
      const tB = new Date(b.time || b.published_at || b.date || 0).getTime();
      return tB - tA;
    });

    renderFeed();
  };

  // ═══════════════════════════════════════════════
  //  CARD RENDERING
  // ═══════════════════════════════════════════════

  const sourceConfig = {
    hackernews: { label: 'HN', cssClass: 'hn' },
    devto: { label: 'Dev.to', cssClass: 'devto' },
    'ai-news': { label: 'TensorFeed', cssClass: 'ai' },
  };

  const renderFeed = () => {
    const filtered = activeFilter === 'all'
      ? allArticles
      : allArticles.filter((a) => a.source === activeFilter);

    if (filtered.length === 0) {
      feedEl.innerHTML = `<div class="feed-error">No articles found. Try refreshing or selecting a different filter.</div>`;
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

      const tagsHtml = Array.isArray(tags) && tags.length
        ? `<div class="card-tags">${tags.slice(0, 4).map((t) => `<span class="tag">#${t}</span>`).join('')}</div>`
        : '';

      return `
        <article class="feed-card" data-source="${article.source}" style="animation-delay:${i * 50}ms">
          <div class="card-top">
            <div class="card-meta-left">
              <span class="source-badge ${src.cssClass}">${src.label}</span>
              ${author ? `<span class="card-author">by <strong>${author}</strong></span>` : ''}
            </div>
            <span class="card-time">${timeAgo(dateStr)}</span>
          </div>
          <h2 class="card-title"><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h2>
          ${tagsHtml}
          <div class="card-bottom">
            <div class="card-stats">
              <span class="stat"><span class="stat-icon">▲</span> ${formatNumber(points)}</span>
              <span class="stat"><span class="stat-icon">💬</span> ${formatNumber(comments)}</span>
            </div>
            <button class="btn-summarize" data-title="${title.replace(/"/g, '&quot;')}" data-url="${url}">
              <span class="sparkle">✨</span> Summarize
            </button>
          </div>
        </article>`;
    }).join('');

    // Attach summarize listeners
    feedEl.querySelectorAll('.btn-summarize').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-title');
        const u = btn.getAttribute('data-url');
        handleSummarize(t, u);
      });
    });
  };

  // ═══════════════════════════════════════════════
  //  FILTER BUTTONS
  // ═══════════════════════════════════════════════

  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.source;
      renderFeed();
    });
  });

  // ═══════════════════════════════════════════════
  //  MODAL
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  const showModalContent = (html, model = '') => {
    modalBody.innerHTML = html;
    if (model) {
      modalModel.textContent = `⚡ ${model}`;
      // Sync header status indicator
      const label = modelStatus.querySelector('.status-label');
      if (label) {
        label.textContent = model;
      }
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

    // Check cache
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

  /** Convert plain text summary to formatted HTML paragraphs */
  const formatSummary = (text) => {
    return text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  };

  // ═══════════════════════════════════════════════
  //  TREND ANALYSIS
  // ═══════════════════════════════════════════════

  trendBtn.addEventListener('click', async () => {
    openModal('📊 Trend Analysis');

    const cacheKey = `trends_${todayKey()}`;
    const cached = getFromCache(cacheKey, TREND_CACHE_TTL);
    if (cached) {
      showModalContent(formatSummary(cached.summary), cached.model);
      return;
    }

    // Collect top 10 headlines
    const headlines = allArticles
      .slice(0, 10)
      .map((a) => a.title || 'Untitled')
      .join('\n');

    if (!headlines) {
      showModalError('No articles loaded yet. Please wait for feeds to load.');
      return;
    }

    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Trend Analysis',
          content: headlines,
          mode: 'trends',
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const summary = data.summary || data.text || data.result || 'No trends found.';
      const model = data.model || 'gemini-2.5-flash';

      setCache(cacheKey, { summary, model });
      showModalContent(formatSummary(summary), model);
    } catch (err) {
      console.error('Trend analysis error:', err);
      showModalError('Unable to generate trend analysis. Please try again later.');
    }
  });

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
        label.textContent = data.model;
      }
    } catch {
      // Silently ignore — status endpoint is optional
    }
  };

  // ═══════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════

  const init = () => {
    fetchAllFeeds();
    updateModelStatus();

    // Auto-refresh
    setInterval(() => {
      fetchAllFeeds();
    }, REFRESH_INTERVAL);
  };

  // Wait for DOM ready (script is at bottom, so should be fine, but just in case)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
