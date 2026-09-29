/* site.js — shared behaviour for the homepage and the case-study pages.
 * Theme toggle (system / light / dark), command palette (Cmd/Ctrl+K or "/"), toast,
 * copy-to-clipboard, scroll reveal, and on case-study pages: reading progress,
 * screenshot lightbox and a "Next project" link. No dependencies, no external requests.
 * Every feature degrades to plain, fully visible content.
 *
 * Theme contract for page scripts (the SOC and Tucson charts use it): the effective theme is
 * html[data-theme] ("light" | "dark") when the reader forced one, else the OS preference. After any
 * change (toggle, palette, another tab, or the OS while in system mode) a 'themechange' event is
 * dispatched on window with detail { mode, theme }. */
(function () {
  'use strict';
  var d = document, root = d.documentElement, w = window;
  var KEY = 'bm-theme';
  var MODES = ['system', 'light', 'dark'];
  var mq = function (q) { return w.matchMedia ? w.matchMedia(q) : { matches: false, addEventListener: function () {} }; };
  var mqDark = mq('(prefers-color-scheme: dark)');
  var mqReduce = mq('(prefers-reduced-motion: reduce)');
  var me = d.currentScript;
  var BASE = me && me.src ? me.src.replace(/assets\/site\.js(?:[?#].*)?$/, '') : '';
  var TYPE = { web: 'Web app', dashboard: 'Dashboard', ios: 'iOS app', 'data-app': 'Data app' };

  function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) w.localStorage.removeItem(k); else w.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // {{manifest:path|fallback}} tokens in projects.json copy: the homepage swaps in live values; here
  // (palette rows) a token shows the live value if the homepage already loaded the manifest, else its fallback.
  // An optional |max=N caps a number at what its sentence can carry: above N the fallback stays.
  function detok(s) {
    return String(s == null ? '' : s).replace(/\{\{manifest:([\w.]+)\|([^{}]*)\}\}/g, function (_, path, rest) {
      var parts = rest.split('|'), fb = parts[0], max = null;
      parts.slice(1).forEach(function (o) { var kv = o.split('='); if (kv[0].trim() === 'max' && kv[1] != null && isFinite(+kv[1])) max = +kv[1]; });
      var v = path.split('.').reduce(function (o, k) { return o != null && typeof o === 'object' ? o[k] : undefined; }, w.SITE_MANIFEST);
      if (typeof v === 'number' && isFinite(v)) return max != null && v > max ? fb : v.toLocaleString('en-US');
      return (typeof v === 'string' && v) ? v : fb;
    });
  }
  // an http(s) URL on another origin
  function isExt(u) {
    if (!/^https?:\/\//i.test(u || '')) return false;
    try { return new URL(u, w.location.href).origin !== w.location.origin; } catch (e) { return true; }
  }
  function el(tag, cls, html) { var n = d.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + p + '</svg>'; }
  var I = {
    system: svg('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
    light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    prev: svg('<path d="M15 18l-6-6 6-6"/>'),
    next: svg('<path d="M9 18l6-6-6-6"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    out: svg('<path d="M7 17 17 7M8 7h9v9"/>'),
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="m3.5 6.5 8.5 7 8.5-7"/>'),
    down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    contrast: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
    home: svg('<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z"/>')
  };

  /* ------------------------------------------------------------------ theme */
  var mode = root.getAttribute('data-theme') || 'system';
  function effective() { return mode === 'system' ? (mqDark.matches ? 'dark' : 'light') : mode; }
  function syncMeta() {
    var m = d.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#f5f1e8');
  }
  function syncToggles() {
    var i = MODES.indexOf(mode);
    [].forEach.call(d.querySelectorAll('.theme-toggle'), function (g) {
      g.style.setProperty('--i', i);
      [].forEach.call(g.querySelectorAll('button'), function (b) {
        var on = b.getAttribute('data-mode') === mode;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    });
  }
  // after (optional) runs once the new mode is applied and the radios are in sync
  function setMode(next, fromOtherTab, after) {
    if (MODES.indexOf(next) < 0 || next === mode) return;
    var apply = function () {
      mode = next;
      if (mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
      if (!fromOtherTab) lsSet(KEY, mode === 'system' ? null : mode);
      syncToggles(); syncMeta();
      if (after) after();
      try { w.dispatchEvent(new CustomEvent('themechange', { detail: { mode: mode, theme: effective() } })); } catch (e) {}
    };
    if (d.startViewTransition && !mqReduce.matches && !fromOtherTab && !d.hidden) d.startViewTransition(apply); else apply();
  }
  // cross-tab sync: a theme chosen in another tab of the site applies here too
  w.addEventListener('storage', function (e) {
    if (e.key !== KEY && e.key !== null) return;
    var v = lsGet(KEY);
    setMode(v === 'light' || v === 'dark' ? v : 'system', true);
  });
  function buildToggle() {
    var g = el('div', 'theme-toggle');
    g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', 'Theme');
    var names = { system: 'Match system theme', light: 'Light theme', dark: 'Dark theme' };
    MODES.forEach(function (m) {
      var b = el('button', null, I[m]);
      b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('data-mode', m);
      b.setAttribute('aria-label', names[m]); b.title = names[m];
      b.addEventListener('click', function () { setMode(m); });
      g.appendChild(b);
    });
    g.addEventListener('keydown', function (e) {
      var k = e.key, i = MODES.indexOf(mode);
      if (k === 'ArrowRight' || k === 'ArrowDown') i = (i + 1) % 3;
      else if (k === 'ArrowLeft' || k === 'ArrowUp') i = (i + 2) % 3;
      else return;
      // focus follows the check: a screen reader never lands on a radio that still reads "not checked"
      e.preventDefault();
      setMode(MODES[i], false, function () { var b = g.querySelector('[data-mode="' + MODES[i] + '"]'); if (b) b.focus(); });
    });
    return g;
  }
  function mountChrome() {
    var slots = [].slice.call(d.querySelectorAll('[data-theme-slot]'));
    var top = d.querySelector('.cs-top');
    if (!slots.length && top) {
      var tools = top.querySelector('.cs-tools') || top.appendChild(el('span', 'cs-tools'));
      slots = [tools];
    }
    slots.forEach(function (s) {
      if (s.classList.contains('cs-tools')) {
        var sb = el('button', 'icon-btn', I.search);
        sb.type = 'button'; sb.setAttribute('data-palette-open', ''); sb.setAttribute('aria-label', 'Search projects');
        sb.setAttribute('aria-keyshortcuts', 'Meta+K Control+K /'); sb.title = 'Search projects';
        s.appendChild(sb);
      }
      s.appendChild(buildToggle());
    });
    syncToggles();
  }
  mqDark.addEventListener && mqDark.addEventListener('change', function () {
    if (mode !== 'system') return;
    syncMeta();
    try { w.dispatchEvent(new CustomEvent('themechange', { detail: { mode: mode, theme: effective() } })); } catch (e) {}
  });

  /* ------------------------------------------------------------------ toast + copy */
  var toastEl, toastT;
  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = el('div', 'toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite');
    d.body.appendChild(toastEl); return toastEl;
  }
  function toast(msg) {
    var t = ensureToast();
    t.innerHTML = I.check + '<span></span>'; t.lastChild.textContent = msg;
    t.classList.add('is-on'); clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('is-on'); }, 2600);
  }
  function copyText(text, msg) {
    var back = d.activeElement;
    function fallback() {
      var ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.setAttribute('aria-hidden', 'true');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      d.body.appendChild(ta); ta.select();
      var ok = false; try { ok = d.execCommand('copy'); } catch (e) {}
      d.body.removeChild(ta); if (back && back.focus) back.focus();
      toast(ok ? msg : 'Copy not available: ' + text);
    }
    if (navigator.clipboard && w.isSecureContext) navigator.clipboard.writeText(text).then(function () { toast(msg); }, fallback);
    else fallback();
  }
  d.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('[data-copy]');
    if (c) { e.preventDefault(); copyText(c.getAttribute('data-copy'), c.getAttribute('data-copy-msg') || 'Copied'); }
    var p = e.target.closest && e.target.closest('[data-palette-open]');
    if (p) { e.preventDefault(); openPalette(); return; }
    // in-page links: smooth scroll (instant under reduced motion) and move focus to the target
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    var id = decodeURIComponent(a.getAttribute('href').slice(1)), t = id && d.getElementById(id);
    if (!t) return;
    e.preventDefault(); goTo(t);
    if (history.pushState) history.pushState(null, '', '#' + id);
  });
  function goTo(t) {
    t.scrollIntoView({ behavior: mqReduce.matches ? 'auto' : 'smooth', block: 'start' });
    // a section hands focus to its heading; <main> (the skip link's target) takes it itself, so the
    // first thing inside it (the homepage's dateline link) is the next Tab stop, not skipped over
    var f = t.matches('section') ? (t.querySelector('h1, h2') || t) : t;
    if (!f.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(f.tagName)) f.setAttribute('tabindex', '-1');
    f.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ reveal */
  var io;
  function reveal() {
    var els = [].slice.call(d.querySelectorAll('[data-reveal]:not(.is-in)'));
    var show = function () { els.forEach(function (e) { e.classList.add('is-in'); }); };
    // html.reveal (content hidden until revealed) is set by the inline <head> script, and only when
    // IntersectionObserver exists and motion is allowed. Without it, nothing is hidden.
    if (!root.classList.contains('reveal') || !('IntersectionObserver' in w) || mqReduce.matches) {
      root.classList.remove('reveal'); show(); return;
    }
    // Arriving after the CSS fail-safe (2 s) has already shown everything: keep it shown.
    if (w.performance && performance.now() > 1800) { show(); root.classList.add('reveal-live'); return; }
    root.classList.add('reveal-live');
    if (!els.length) return;
    io = io || new IntersectionObserver(function (entries) {
      var k = 0;
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var t = en.target;
        t.style.setProperty('--i', Math.min(k++, 6));
        t.classList.add('is-in'); io.unobserve(t);
        var done = function (ev) {
          if (ev.target !== t || ev.propertyName !== 'opacity') return;
          t.removeAttribute('data-reveal'); t.style.removeProperty('--i'); t.removeEventListener('transitionend', done);
        };
        t.addEventListener('transitionend', done);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ------------------------------------------------------------------ data (homepage inline, else projects.json) */
  var dataP;
  function getData() {
    if (w.SITE_DATA) return Promise.resolve(w.SITE_DATA);
    if (!dataP) {
      dataP = (w.fetch ? fetch(BASE + 'projects.json', { cache: 'no-cache' }) : Promise.reject())
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch(function () { return null; });
    }
    return dataP;
  }
  function ordered(list) {
    list = (list || []).filter(function (p) { return p && p.slug && p.title; });
    return list.filter(function (p) { return p.featured; }).concat(list.filter(function (p) { return !p.featured; }));
  }
  function href(p) { var l = p.link || ('projects/' + p.slug + '/'); return /^[a-z][a-z0-9+.-]*:|^\/\//i.test(l) ? l : BASE + l; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ------------------------------------------------------------------ command palette */
  var pal, input, list, live, items = [], shown = [], active = 0, lastFocus, uid = 0;
  function buildItems(data) {
    var site = (data && data.site) || {}, out = [];
    ordered(data && data.projects).forEach(function (p, i) {
      var link = href(p), ext = isExt(link);
      out.push({ group: 'Projects', no: pad(i + 1), title: detok(p.title), meta: ext ? 'New tab' : (TYPE[p.type] || ''),
        desc: detok(p.description), thumb: p.thumb && w.SITE_DATA && !isExt(p.thumb) ? BASE + p.thumb : '', project: 1,
        keys: detok([p.type, TYPE[p.type], (p.tech || []).join(' '), p.description].join(' ')), href: link, ext: ext });
    });
    var onHome = !!d.getElementById('process');
    if (site.email) {
      out.push({ group: 'Actions', icon: I.copy, title: 'Copy email address', meta: site.email, plain: 1, keys: 'contact mail clipboard',
        run: function () { copyText(site.email, 'Email address copied'); } });
      out.push({ group: 'Actions', icon: I.mail, title: 'Write an email', meta: site.email, plain: 1, keys: 'contact mail',
        run: function () { w.location.href = 'mailto:' + site.email; } });
    }
    if (site.linkedin) out.push({ group: 'Actions', icon: I.out, title: 'Open LinkedIn', meta: 'New tab', keys: 'contact profile',
      run: function () { w.open(site.linkedin, '_blank', 'noopener'); } });
    if (site.github) out.push({ group: 'Actions', icon: I.out, title: 'Open GitHub', meta: 'New tab', keys: 'code',
      run: function () { w.open(site.github, '_blank', 'noopener'); } });
    // the three theme choices; the active one is marked "Current"
    [['light', 'Light theme', 'toggle theme appearance mode colour color light day'],
     ['dark', 'Dark theme', 'toggle theme appearance mode colour color dark night'],
     ['system', 'Match system theme', 'toggle theme appearance mode colour color auto os device']].forEach(function (t) {
      var on = mode === t[0];
      out.push({ group: 'Actions', icon: I[t[0]], title: t[1], meta: on ? 'Current' : 'Theme', current: on, keys: t[2],
        run: function () { setMode(t[0]); } });
    });
    var proc = (site.process && site.process.heading) || 'How I work';
    out.push({ group: 'Actions', icon: I.down, title: 'Go to “' + proc + '”', meta: 'Section', keys: 'process principles approach about jump',
      run: onHome ? function () { jump('process'); } : null, moves: onHome, href: onHome ? null : BASE + '#process' });
    if (onHome && d.getElementById('contact')) out.push({ group: 'Actions', icon: I.down, title: 'Go to contact', meta: 'Section', keys: 'email linkedin jump',
      run: function () { jump('contact'); }, moves: true });
    if (!onHome) out.push({ group: 'Actions', icon: I.home, title: 'All projects', meta: 'Home', keys: 'home index gallery back', href: BASE || './' });
    return out;
  }
  function jump(id) { var t = d.getElementById(id); if (t) goTo(t); }
  function score(it, words) {
    if (!words.length) return 1;
    var t = it.title.toLowerCase(), near = (it.title + ' ' + (it.meta || '')).toLowerCase(), hay = near + ' ' + String(it.keys || '').toLowerCase(), s = 0;
    for (var i = 0; i < words.length; i++) {
      var wd = words[i], at = t.indexOf(wd);
      if (at === 0) s += 5; else if (at > 0 && /\s/.test(t.charAt(at - 1))) s += 4; else if (at > 0) s += 2;
      else if ((wd.length < 3 ? near : hay).indexOf(wd) >= 0) s += 1; else return 0;
    }
    return s;
  }
  function mark(title, words) {
    var low = title.toLowerCase(), r = [];
    words.forEach(function (wd) { var at = low.indexOf(wd); if (at >= 0) r.push([at, at + wd.length]); });
    r.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    r.forEach(function (x) { if (x[0] < pos) return; out += esc(title.slice(pos, x[0])) + '<mark>' + esc(title.slice(x[0], x[1])) + '</mark>'; pos = x[1]; });
    return out + esc(title.slice(pos));
  }
  function renderList() {
    var words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    var scored = items.map(function (it, i) { return { it: it, s: score(it, words), i: i }; }).filter(function (x) { return x.s > 0; });
    if (words.length) scored.sort(function (a, b) { return (a.it.group === b.it.group ? 0 : a.it.group === 'Projects' ? -1 : 1) || b.s - a.s || a.i - b.i; });
    shown = scored.map(function (x) { return x.it; });
    active = 0;
    var html = '', grp = null, gi = 0;
    shown.forEach(function (it, i) {
      if (it.group !== grp) {
        if (grp) html += '</div>';
        grp = it.group; gi++;
        html += '<div role="group" aria-labelledby="pal-g' + gi + '"><div class="palette__group label" id="pal-g' + gi + '" role="presentation">' + esc(grp) + '</div>';
      }
      var title = '<span class="o-title">' + mark(it.title, words) + '</span>';
      html += '<div class="palette__opt' + (it.thumb ? ' has-thumb' : '') + '" role="option" id="pal-o' + i + '" data-i="' + i + '" aria-selected="' + (i === 0) + '">'
        + '<span class="o-no" aria-hidden="true">' + (it.icon || esc(it.no)) + '</span>'
        + (it.project ? (it.thumb ? '<img class="o-thumb" src="' + esc(it.thumb) + '" alt="" width="64" height="36" decoding="async">' : '')
          + '<span class="o-text">' + title + (it.desc ? '<span class="o-desc" aria-hidden="true">' + esc(it.desc) + '</span>' : '') + '</span>' : title)
        + '<span class="o-meta' + (it.plain ? ' is-plain' : '') + (it.current ? ' is-current' : '') + '">' + esc(it.meta || '') + '</span></div>';
    });
    if (grp) html += '</div>';
    list.innerHTML = html || '<div class="palette__empty">No matches</div>';
    input.setAttribute('aria-activedescendant', shown.length ? 'pal-o0' : '');
    live.textContent = shown.length ? shown.length + (shown.length === 1 ? ' result' : ' results') : 'No matches';
  }
  function setActive(i, scroll) {
    if (!shown.length) return;
    active = (i + shown.length) % shown.length;
    [].forEach.call(list.querySelectorAll('.palette__opt'), function (o) {
      o.setAttribute('aria-selected', String(+o.getAttribute('data-i') === active));
    });
    var cur = d.getElementById('pal-o' + active);
    input.setAttribute('aria-activedescendant', 'pal-o' + active);
    if (cur && scroll) cur.scrollIntoView({ block: 'nearest' });
  }
  function runItem(it, newTab) {
    if (!it) return;
    if (it.ext) newTab = true;
    if (it.href && (newTab || !it.run)) {
      closePalette(true);
      if (newTab) w.open(it.href, '_blank', 'noopener'); else w.location.href = it.href;
      return;
    }
    // an item that moves focus itself (a jump to a section) must not have focus handed back to the
    // palette's opener afterwards
    closePalette(!!it.moves); if (it.run) it.run();
  }
  function buildPalette() {
    pal = el('dialog', 'palette');
    pal.setAttribute('aria-label', 'Search projects and actions');
    var id = 'pal-list-' + (++uid);
    pal.innerHTML = '<div class="palette__box">'
      + '<div class="palette__field">' + I.search
      + '<input type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="' + id + '"'
      + ' aria-label="Search projects and actions" placeholder="Search projects and actions" autocomplete="off" autocapitalize="off" spellcheck="false">'
      + '<button type="button" class="palette__x" aria-label="Esc, close search" tabindex="-1"><kbd>esc</kbd><span class="px-ico">' + I.close + '</span></button></div>'
      + '<div class="palette__list" role="listbox" id="' + id + '" aria-label="Results"></div>'
      + '<div class="palette__foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> Move</span><span><kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></div>'
      + '<div class="sr-only" aria-live="polite"></div></div>';
    d.body.appendChild(pal);
    input = pal.querySelector('input'); list = pal.querySelector('.palette__list'); live = pal.querySelector('.sr-only');
    input.addEventListener('input', renderList);
    pal.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1, true); }
      else if (e.key === 'PageDown') { e.preventDefault(); setActive(shown.length - 1, true); }
      else if (e.key === 'PageUp') { e.preventDefault(); setActive(0, true); }
      else if (e.key === 'Enter') { e.preventDefault(); runItem(shown[active], e.metaKey || e.ctrlKey); }
      else if (e.key === 'Tab') { e.preventDefault(); input.focus(); }
    });
    list.addEventListener('mousemove', function (e) {
      var o = e.target.closest('.palette__opt'); if (o && +o.getAttribute('data-i') !== active) setActive(+o.getAttribute('data-i'));
    });
    list.addEventListener('click', function (e) {
      var o = e.target.closest('.palette__opt'); if (o) runItem(shown[+o.getAttribute('data-i')], e.metaKey || e.ctrlKey);
    });
    pal.addEventListener('click', function (e) { if (e.target === pal || e.target.closest('.palette__x')) closePalette(); });
    pal.addEventListener('close', function () {
      root.classList.remove('palette-open');
      if (!pal._leaving && lastFocus && lastFocus.focus && d.contains(lastFocus)) lastFocus.focus();
      pal._leaving = false;
    });
  }
  function openPalette() {
    if (!w.HTMLDialogElement) return;
    if (!pal) buildPalette();
    if (pal.open) return;
    lastFocus = d.activeElement;
    input.value = '';
    items = buildItems(w.SITE_DATA || null); renderList();
    pal.showModal(); root.classList.add('palette-open'); input.focus();
    if (!w.SITE_DATA) getData().then(function (data) {
      if (data && pal.open) { items = buildItems(data); renderList(); }
    });
  }
  function closePalette(leaving) { if (pal && pal.open) { pal._leaving = !!leaving; pal.close(); } }
  function typing(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
  d.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); if (pal && pal.open) closePalette(); else openPalette(); return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) && !d.querySelector('dialog[open]')) {
      e.preventDefault(); openPalette();
    }
  });

  /* ------------------------------------------------------------------ external links */
  // Any http(s) link to another origin opens in a new tab, with a small ↗ and a visually hidden
  // "(opens in a new tab)". Links that already open a new tab (the homepage builds its own) are left alone.
  function markExternal(scope) {
    [].forEach.call((scope || d).querySelectorAll('a[href]'), function (a) {
      if (a.target || a.hasAttribute('data-ext') || !isExt(a.getAttribute('href'))) return;
      a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('data-ext', '');
      a.insertAdjacentHTML('beforeend', '<span class="ext" aria-hidden="true">\u2197</span><span class="sr-only"> (opens in a new tab)</span>');
    });
  }

  /* ------------------------------------------------------------------ case-study pages */
  function initProgress() {
    var bar = el('div', 'read-progress', '<span></span>'); bar.setAttribute('aria-hidden', 'true');
    d.body.appendChild(bar);
    if (w.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()')) { bar.classList.add('css'); return; }
    var s = bar.firstChild, tick = false;
    function upd() {
      tick = false; var h = root.scrollHeight - root.clientHeight;
      s.style.transform = 'scaleX(' + (h > 0 ? Math.min(1, Math.max(0, (w.scrollY || root.scrollTop) / h)) : 0) + ')';
    }
    w.addEventListener('scroll', function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    w.addEventListener('resize', upd); upd();
  }

  function initLightbox() {
    var imgs = [].slice.call(d.querySelectorAll('.shots img, .figure img')).filter(function (i) { return !i.closest('a, button'); });
    if (!imgs.length || !w.HTMLDialogElement) return;
    var box, big, cap, count, spoken, said, idx = 0, trigger = [];
    function caption(img) { var f = img.closest('figure'); var c = f && f.querySelector('figcaption'); return (c && c.textContent.trim()) || img.alt || ''; }
    function show(i, announce) {
      idx = (i + imgs.length) % imgs.length;
      var img = imgs[idx];
      big.src = img.currentSrc || img.src; big.alt = img.alt || '';
      cap.lastChild.textContent = caption(img);
      count.textContent = imgs.length > 1 ? (idx + 1) + ' / ' + imgs.length : '';
      // the visible "1 / 6" is hidden from assistive tech; the dialog's description reads "Image 1 of 6: caption"
      spoken.textContent = imgs.length > 1 ? 'Image ' + (idx + 1) + ' of ' + imgs.length + ': ' : '';
      // on open the dialog's description reads the caption; moving on is announced here
      said.textContent = announce ? 'Image ' + (idx + 1) + ' of ' + imgs.length + ': ' + caption(img) : '';
    }
    function build() {
      box = el('dialog', 'lightbox');
      box.setAttribute('aria-label', 'Image viewer');
      box.setAttribute('aria-describedby', 'lb-cap');
      box.innerHTML = '<div class="lb__stage"><img class="lb__img" alt=""><p class="lb__cap" id="lb-cap"><span class="lb__count" aria-hidden="true"></span><span class="sr-only"></span><span></span></p></div>'
        + '<p class="sr-only" aria-live="polite" aria-atomic="true"></p>'
        + '<button type="button" class="lb__btn lb__close" aria-label="Close image viewer">' + I.close + '</button>'
        + (imgs.length > 1 ? '<button type="button" class="lb__btn lb__prev" aria-label="Previous image">' + I.prev + '</button>'
        + '<button type="button" class="lb__btn lb__next" aria-label="Next image">' + I.next + '</button>' : '');
      d.body.appendChild(box);
      big = box.querySelector('.lb__img'); cap = box.querySelector('.lb__cap'); count = box.querySelector('.lb__count');
      spoken = cap.querySelector('.sr-only');
      said = box.querySelector('[aria-live]');
      box.querySelector('.lb__close').addEventListener('click', function () { box.close(); });
      if (imgs.length > 1) {
        box.querySelector('.lb__prev').addEventListener('click', function () { show(idx - 1, true); });
        box.querySelector('.lb__next').addEventListener('click', function () { show(idx + 1, true); });
      }
      box.addEventListener('click', function (e) {
        if (e.target === box || e.target.classList.contains('lb__stage') || e.target === big) box.close();
      });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1, true); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1, true); }
        else if (e.key === 'Tab') {
          var f = [].slice.call(box.querySelectorAll('button')), at = f.indexOf(d.activeElement);
          e.preventDefault(); f[(at + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
      });
      box.addEventListener('close', function () { var t = trigger[idx]; if (t && t.focus) t.focus(); });
    }
    imgs.forEach(function (img, i) {
      var b = el('button', 'zoomable'); b.type = 'button';
      b.setAttribute('aria-label', 'Enlarge image' + (img.alt ? ': ' + img.alt : ''));
      b.setAttribute('aria-haspopup', 'dialog');
      img.parentNode.insertBefore(b, img); b.appendChild(img);
      trigger[i] = b;
      b.addEventListener('click', function () { if (!box) build(); show(i); box.showModal(); box.querySelector('.lb__close').focus(); });
    });
  }

  function initNext() {
    var foot = d.querySelector('footer.cs-foot');
    var m = w.location.pathname.match(/\/projects\/([^\/]+)\/?/);
    if (!foot || !m) return;
    var slug = decodeURIComponent(m[1]);
    getData().then(function (data) {
      var all = ordered(data && data.projects), i = -1;
      all.forEach(function (p, k) { if (p.slug === slug) i = k; });
      if (i < 0 || all.length < 2) return;
      var nx = all[(i + 1) % all.length];
      var a = el('a', 'next-link', '<span class="label">Next project</span><span class="next-title"><span></span><span class="arr" aria-hidden="true">→</span></span>');
      a.href = href(nx); a.querySelector('.next-title span').textContent = nx.title;
      foot.appendChild(a); markExternal(foot);
    });
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    mountChrome(); ensureToast(); syncMeta(); reveal(); markExternal();
    if (d.querySelector('.cs-head')) { initProgress(); initLightbox(); initNext(); }
  }
  w.Site = { toast: toast, copy: copyText, reveal: reveal, openPalette: openPalette, setMode: setMode, markExternal: markExternal,
    theme: effective, TYPE: TYPE };
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot); else boot();
})();
