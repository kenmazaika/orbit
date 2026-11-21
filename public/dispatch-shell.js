(() => {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const readSet = (key) => {
    try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
  };
  const formatDate = (value) => new Date(value).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const category = (d) => (Array.isArray(d.tags) && d.tags[0]) || 'Dispatch';
  const safeUrl = (value) => {
    const raw = String(value || '').replace(/&amp;/g, '&');
    return /^(https?:\/\/|\/)/i.test(raw) ? esc(raw) : '#';
  };

  function inline(text) {
    let out = esc(text);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (_, alt, url) => `<img alt="${alt}" src="${safeUrl(url)}" loading="lazy">`);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label, url) => `<a href="${safeUrl(url)}" rel="noopener noreferrer">${label}</a>`);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  function markdown(value) {
    let source = String(value || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const code = [];
    source = source.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
      const id = code.length; code.push(`<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`); return `\n@@CODE${id}@@\n`;
    });
    const lines = source.split(/\r?\n/); const out = []; let para = []; let list = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of lines) {
      const trimmed = line.trim();
      const token = trimmed.match(/^@@CODE(\d+)@@$/);
      if (token) { flushPara(); closeList(); out.push(code[Number(token[1])]); continue; }
      if (!trimmed) { flushPara(); closeList(); continue; }
      const heading = trimmed.match(/^(#{2,3})\s+(.+)$/);
      if (heading) { flushPara(); closeList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
      if (/^---+$/.test(trimmed)) { flushPara(); closeList(); out.push('<hr>'); continue; }
      const bullet = trimmed.match(/^[-*+]\s+(.+)$/); const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (bullet || ordered) {
        flushPara(); const kind = ordered ? 'ol' : 'ul';
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((bullet || ordered)[1])}</li>`); continue;
      }
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (quote) { flushPara(); closeList(); out.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`); continue; }
      para.push(trimmed);
    }
    flushPara(); closeList(); return out.join('\n');
  }

  async function feed(host) {
    const loading = host.querySelector('[data-dispatch-loading]');
    try {
      const res = await fetch('/api/v1/dispatches?limit=100', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json(); const read = readSet('orbit:read');
      const nodes = (data.dispatches || []).map((d) => {
        const a = document.createElement('a'); a.className = 'feed-item';
        a.href = `/notes/${encodeURIComponent(d.slug)}/`; a.dataset.slug = d.slug; a.dataset.published = d.published_at || d.created_at;
        a.innerHTML = `<div class="feed-meta"><span>${esc(formatDate(a.dataset.published))} <span class="sep">·</span> ${esc(category(d))}</span>` +
          `${read.has(d.slug) ? '' : '<span class="unread" data-unread><span class="dot"></span>Unread</span>'}</div>` +
          `<h2 class="feed-title">${esc(d.title)}</h2><p class="feed-excerpt">${esc(d.summary || '')}</p>` +
          `<span class="read-time">${Number(d.minutes || 1)} min read</span>`;
        return a;
      });
      const existing = [...host.querySelectorAll('.feed-item')];
      for (const item of existing) {
        const badge = item.querySelector('[data-unread]');
        if (badge && !read.has(item.dataset.slug)) badge.hidden = false;
      }
      for (const node of [...nodes, ...existing].sort((a, b) => String(b.dataset.published).localeCompare(String(a.dataset.published)))) host.append(node);
      loading?.remove();
      if (!nodes.length && !existing.length) host.innerHTML = '<p class="empty">Nothing published yet.</p>';
    } catch {
      if (loading) loading.textContent = 'Could not load dispatches. Try again in a moment.';
    }
  }

  async function detail(article) {
    const host = article.querySelector('[data-dispatch-article]');
    const slug = decodeURIComponent(location.pathname.replace(/^\/notes\//, '').replace(/\/$/, ''));
    try {
      const res = await fetch(`/api/v1/dispatches/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { dispatch: d } = await res.json();
      document.title = `${d.title} · Orbit`;
      host.innerHTML = `<div class="article-meta"><span>${esc(formatDate(d.published_at || d.created_at))}</span>` +
        `<span class="sep">·</span><span class="cat-pill">${esc(category(d))}</span>` +
        `<span class="sep">·</span><span>${Number(d.minutes || 1)} min read</span></div>` +
        `<h1 class="article-title">${esc(d.title)}</h1>${d.summary ? `<p class="dek">${esc(d.summary)}</p>` : ''}` +
        `<div class="prose">${markdown(d.content)}</div><footer class="article-foot"><button type="button" data-save>Save for later</button></footer>`;
      const read = readSet('orbit:read'); read.add(d.slug); localStorage.setItem('orbit:read', JSON.stringify([...read]));
      const button = host.querySelector('[data-save]');
      const paint = () => { const on = readSet('orbit:saved').has(d.slug); button.textContent = on ? 'Saved' : 'Save for later'; button.classList.toggle('is-saved', on); };
      button.addEventListener('click', () => { const saved = readSet('orbit:saved'); saved.has(d.slug) ? saved.delete(d.slug) : saved.add(d.slug); localStorage.setItem('orbit:saved', JSON.stringify([...saved])); paint(); });
      paint();
    } catch {
      host.innerHTML = '<p class="empty">This dispatch could not be loaded.</p>';
    }
  }

  const feedHost = document.querySelector('[data-dispatch-feed]'); if (feedHost) feed(feedHost);
  const detailHost = document.querySelector('[data-dispatch-detail]'); if (detailHost) detail(detailHost);
})();
