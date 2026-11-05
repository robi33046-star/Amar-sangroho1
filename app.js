(function () {
  'use strict';

  /* ---------- helpers ---------- */
  var MiB = 1048576, GiB = 1073741824;
  var nf = new Intl.NumberFormat('bn-BD');
  var df = new Intl.DateTimeFormat('bn-BD', { year: 'numeric', month: 'short', day: 'numeric' });
  var ICONS = {
    links: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    videos: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 9.5v5l4.5-2.5z"/>',
    images: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="M3.5 17l5-5 4 4 3-3 5 5"/>',
    pdfs: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 14h7M9 17.5h5"/>',
    home: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'
  };
  function icon(name) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name] || '';
    return s;
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function $(id) { return document.getElementById(id); }
  function fmtSize(b) {
    if (b >= GiB) return nf.format(Math.round(b / GiB * 100) / 100) + ' জিবি';
    if (b >= MiB) return nf.format(Math.round(b / MiB * 10) / 10) + ' এমবি';
    return nf.format(Math.max(1, Math.round(b / 1024))) + ' কেবি';
  }
  function fmtDate(n) { try { return df.format(new Date(n)); } catch (e) { return ''; } }
  function tryStore(fn) { try { return fn(); } catch (e) { return null; } }
  var toastTimer = 0;
  function toast(text) {
    var t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- api ---------- */
  function api(method, path, body, raw) {
    var opt = { method: method, headers: { 'X-Requested-With': 'sangroho' }, credentials: 'same-origin' };
    if (raw !== undefined) { opt.body = raw; opt.headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined && body !== null) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    return fetch(path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
        if (!r.ok) throw { status: r.status, code: j && j.error };
        return j;
      });
    });
  }
  function errText(e) {
    var c = e && e.code;
    if (e && e.status === 0) return 'ইন্টারনেট সংযোগ নেই। সংযোগ ফিরলে আবার চেষ্টা করুন।';
    var map = {
      bad_url: 'ঠিকানাটি http:// বা https:// দিয়ে শুরু হওয়া ঠিক ঠিকানা হতে হবে।',
      duplicate: 'এই লিংকটি আগেই যোগ করা আছে।',
      bad_type: 'এই ধরনের ফাইল চলবে না।',
      empty: 'ফাইলটি ফাঁকা।',
      too_large: 'ফাইলটি সীমার চেয়ে বড়।',
      storage_full: 'সাইটের সংরক্ষণের জায়গা পূর্ণ।',
      too_many: 'অনেক বেশি অনুরোধ হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।',
      busy: 'সার্ভার এখন ব্যস্ত। একটু পরে চেষ্টা করুন।',
      content_mismatch: 'ফাইলের ভেতরের বিষয়বস্তু ফাইলের ধরনের সঙ্গে মেলেনি।',
      wrong_password: 'পাসওয়ার্ড ঠিক নয়।',
      admin_only: 'মোছার অনুমতি শুধু অ্যাডমিনের।',
      forbidden: 'অনুরোধটি গ্রহণ করা হয়নি। পাতাটি রিলোড করুন।'
    };
    return map[c] || 'কিছু একটা ভুল হয়েছে। একটু পরে আবার চেষ্টা করুন।';
  }
  function net(fn) {
    return fn().catch(function (e) {
      if (e && typeof e.status === 'number') throw e;
      throw { status: 0 };
    });
  }

  /* ---------- config ---------- */
  var KINDS = {
    links:  { label: 'লিংক',   one: 'লিংক',   emptyTitle: 'এখনো কোনো লিংক নেই', emptyText: 'উপরের ফর্মে ঠিকানা দিয়ে প্রথম লিংকটি যোগ করুন।' },
    videos: { label: 'ভিডিও',  one: 'ভিডিও',  emptyTitle: 'এখনো কোনো ভিডিও নেই', emptyText: 'MP4 বা WebM ফাইল আপলোড করলে এখানে চালানো যাবে।' },
    images: { label: 'ছবি',    one: 'ছবি',    emptyTitle: 'এখনো কোনো ছবি নেই', emptyText: 'PNG, JPG, GIF বা WebP ছবি আপলোড করুন।' },
    pdfs:   { label: 'পিডিএফ', one: 'পিডিএফ', emptyTitle: 'এখনো কোনো পিডিএফ নেই', emptyText: 'পিডিএফ ফাইল আপলোড করলে এখানে খোলা যাবে।' }
  };
  var ORDER = ['links', 'videos', 'images', 'pdfs'];
  var VIEWS = ['home'].concat(ORDER);
  var MIME_BY_EXT = { mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };

  var cfg = { chunkSize: 8 * MiB, limits: { videos: 2048 * MiB, images: 50 * MiB, pdfs: 200 * MiB }, types: { videos: ['mp4', 'webm'], images: ['png', 'jpg', 'jpeg', 'gif', 'webp'], pdfs: ['pdf'] }, used: 0, total: 0 };
  var items = [];
  var loaded = false, failedLoad = false;
  var admin = false;
  var ui = {};
  ORDER.forEach(function (k) { ui[k] = { q: '', sort: 'new' }; });
  var pendingDelete = null;
  var busy = {};
  var els = {};

  /* ---------- theme ---------- */
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function paintThemeBtn() { clear(els.themeBtn); els.themeBtn.appendChild(icon(currentTheme() === 'dark' ? 'sun' : 'moon')); }
  function initTheme() {
    var saved = tryStore(function () { return localStorage.getItem('sg-theme'); });
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    els.themeBtn.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      tryStore(function () { localStorage.setItem('sg-theme', next); });
      paintThemeBtn();
    });
    paintThemeBtn();
  }

  /* ---------- data ---------- */
  function ofKind(k) { return items.filter(function (i) { return i.kind === k; }); }
  function safeHttp(u) { try { var p = new URL(String(u)); return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : null; } catch (e) { return null; } }
  function loadItems() {
    return net(function () { return api('GET', '/api/items'); }).then(function (r) {
      items = r.items || []; admin = !!r.admin; loaded = true; failedLoad = false;
    }).catch(function () { failedLoad = true; loaded = loaded || false; });
  }
  function loadConfig() {
    return net(function () { return api('GET', '/api/config'); }).then(function (c) {
      cfg = c; admin = !!c.admin;
    }).catch(function () { /* defaults stay */ });
  }
  function refresh() { return loadItems().then(renderAll); }

  /* ---------- routing ---------- */
  function currentView() {
    var v = (location.hash || '').replace('#', '');
    return VIEWS.indexOf(v) >= 0 ? v : 'home';
  }
  function showView() {
    var v = currentView();
    VIEWS.forEach(function (name) { els['view-' + name].hidden = name !== v; });
    var tabs = els.tabs.querySelectorAll('a');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-view') === v) tabs[i].setAttribute('aria-current', 'page');
      else tabs[i].removeAttribute('aria-current');
    }
    window.scrollTo(0, 0);
  }

  /* ---------- skeleton ---------- */
  function buildTabs() {
    var all = [{ id: 'home', label: 'সারসংক্ষেপ' }].concat(ORDER.map(function (k) { return { id: k, label: KINDS[k].label }; }));
    all.forEach(function (t) {
      var n = h('span', { class: 'n', id: 'cnt-' + t.id });
      els.tabs.appendChild(h('a', { class: 'tab', href: '#' + t.id, 'data-view': t.id }, icon(t.id), t.label, t.id === 'home' ? null : n));
    });
  }
  function buildHome() {
    var v = els['view-home'];
    v.appendChild(h('p', { class: 'lead', text: 'এখানে সব লিংক, ভিডিও, ছবি ও পিডিএফ আলাদা আলাদা বিভাগে গোছানো থাকে। যে কেউ যেকোনো বিভাগে গিয়ে নতুন কিছু যোগ করতে পারে।' }));
    v.appendChild(h('div', { class: 'sum-grid', id: 'sum-grid' }));
    v.appendChild(h('h2', { class: 'sec-title', text: 'সাম্প্রতিক যোগ' }));
    v.appendChild(h('ul', { class: 'recent', id: 'recent' }));
    v.appendChild(h('div', { class: 'meter', id: 'meter', hidden: true }));
  }
  function buildSection(kind) {
    var c = KINDS[kind];
    var v = els['view-' + kind];
    v.appendChild(h('div', { class: 'sec-head' }, h('h2', { text: c.label }), h('span', { class: 'count', id: 'head-count-' + kind })));
    v.appendChild(kind === 'links' ? linkForm() : fileForm(kind));
    v.appendChild(h('div', { class: 'tools' },
      h('div', { class: 'field' },
        h('label', { for: 'q-' + kind, class: 'sr', text: c.label + ' খুঁজুন' }),
        h('input', { type: 'search', id: 'q-' + kind, placeholder: c.label + ' খুঁজুন', autocomplete: 'off', oninput: function (e) { ui[kind].q = e.target.value; renderList(kind); } })),
      h('div', { class: 'field sort' },
        h('label', { for: 's-' + kind, class: 'sr', text: 'সাজানো' }),
        h('select', { id: 's-' + kind, onchange: function (e) { ui[kind].sort = e.target.value; renderList(kind); } },
          h('option', { value: 'new', text: 'নতুন আগে' }),
          h('option', { value: 'old', text: 'পুরোনো আগে' }),
          h('option', { value: 'name', text: 'নাম অনুসারে' })))));
    v.appendChild(h('div', { id: 'list-' + kind }));
  }
  function setMsg(kind, text, tone) {
    var m = $('msg-' + kind);
    if (m) { m.textContent = text || ''; m.setAttribute('data-tone', tone || 'info'); }
  }

  /* ---------- link form ---------- */
  function linkForm() {
    var form = h('form', { class: 'panel', novalidate: true, id: 'form-links' },
      h('h3', null, h('span', { class: 'chip k-links' }, icon('links')), 'নতুন লিংক যোগ করুন'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field wide' },
          h('label', { for: 'links-url', text: 'ঠিকানা (URL)' }),
          h('input', { type: 'url', id: 'links-url', placeholder: 'https://example.com', inputmode: 'url', autocomplete: 'off', maxlength: '2000' })),
        h('div', { class: 'field' },
          h('label', { for: 'links-title', text: 'শিরোনাম' }),
          h('input', { type: 'text', id: 'links-title', maxlength: '120', placeholder: 'ফাঁকা রাখলে সাইটের নাম বসবে' })),
        h('div', { class: 'field' },
          h('label', { for: 'links-note', text: 'ছোট নোট' }),
          h('input', { type: 'text', id: 'links-note', maxlength: '300', placeholder: 'ঐচ্ছিক' }))),
      h('div', { class: 'actions' },
        h('button', { type: 'submit', class: 'btn', id: 'btn-links' }, icon('upload'), 'লিংক যোগ করুন'),
        h('p', { class: 'msg', id: 'msg-links', 'data-tone': 'info' })));
    form.addEventListener('submit', function (e) { e.preventDefault(); submitLink(form); });
    return form;
  }
  function submitLink(form) {
    if (busy.links) return;
    var urlEl = $('links-url');
    var raw = urlEl.value.trim();
    if (!raw) { setMsg('links', 'ঠিকানা লিখুন।', 'err'); urlEl.focus(); return; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
    var href = safeHttp(raw);
    if (!href) { setMsg('links', errText({ code: 'bad_url' }), 'err'); urlEl.focus(); return; }
    busy.links = true; $('btn-links').disabled = true; setMsg('links', 'সংরক্ষণ হচ্ছে…', 'info');
    net(function () { return api('POST', '/api/links', { url: href, title: $('links-title').value, note: $('links-note').value }); })
      .then(function () { form.reset(); setMsg('links', 'লিংক যোগ হয়েছে।', 'ok'); toast('লিংক যোগ হয়েছে'); return refresh(); })
      .catch(function (e) { setMsg('links', errText(e), 'err'); })
      .then(function () { busy.links = false; $('btn-links').disabled = false; });
  }

  /* ---------- file form + chunked upload ---------- */
  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function validateFile(kind, f) {
    if ((cfg.types[kind] || []).indexOf(extOf(f.name)) < 0) return 'এই ধরনের ফাইল চলবে না';
    if (!f.size) return 'ফাইলটি ফাঁকা';
    if (f.size > cfg.limits[kind]) return 'সীমা ' + fmtSize(cfg.limits[kind]);
    return '';
  }
  function fileForm(kind) {
    var c = KINDS[kind];
    var input = h('input', { type: 'file', id: 'file-' + kind, class: 'sr', multiple: true });
    var picked = h('ul', { class: 'picked', id: 'picked-' + kind });
    var drop = h('label', { class: 'drop', for: 'file-' + kind },
      h('strong', { text: 'ফাইল বেছে নিন বা এখানে টেনে আনুন' }),
      h('span', { id: 'hint-' + kind }));
    var progress = h('ul', { class: 'progress-list', id: 'progress-' + kind });
    function showPicked() {
      clear(picked);
      Array.prototype.forEach.call(input.files || [], function (f) {
        var err = validateFile(kind, f);
        picked.appendChild(h('li', { class: err ? 'bad' : '' }, h('span', { text: f.name }), h('span', { text: err || fmtSize(f.size) })));
      });
      setMsg(kind, '', 'info');
    }
    input.addEventListener('change', showPicked);
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        try { input.files = e.dataTransfer.files; } catch (x) { return; }
        showPicked();
      }
    });
    var form = h('form', { class: 'panel', novalidate: true, id: 'form-' + kind },
      h('h3', null, h('span', { class: 'chip k-' + kind }, icon(kind)), 'নতুন ' + c.one + ' আপলোড করুন'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field wide' }, h('span', { class: 'lbl', text: 'ফাইল' }), input, drop, picked),
        h('div', { class: 'field' },
          h('label', { for: 'title-' + kind, text: 'শিরোনাম' }),
          h('input', { type: 'text', id: 'title-' + kind, maxlength: '120', placeholder: 'ফাঁকা রাখলে ফাইলের নাম বসবে' }),
          h('span', { class: 'hint', text: 'একসঙ্গে অনেক ফাইল দিলে প্রতিটির নিজের নাম ব্যবহার হবে।' })),
        h('div', { class: 'field' },
          h('label', { for: 'note-' + kind, text: 'ছোট নোট' }),
          h('input', { type: 'text', id: 'note-' + kind, maxlength: '300', placeholder: 'ঐচ্ছিক' }))),
      progress,
      h('div', { class: 'actions' },
        h('button', { type: 'submit', class: 'btn', id: 'btn-' + kind }, icon('upload'), 'আপলোড করুন'),
        h('p', { class: 'msg', id: 'msg-' + kind, 'data-tone': 'info' })));
    form.addEventListener('submit', function (e) { e.preventDefault(); submitFiles(kind, form, input, picked, progress); });
    return form;
  }
  function paintHints() {
    ['videos', 'images', 'pdfs'].forEach(function (k) {
      var el = $('hint-' + k);
      if (el) el.textContent = (cfg.types[k] || []).map(function (x) { return x.toUpperCase(); }).join(', ') + ' · প্রতিটি সর্বোচ্চ ' + fmtSize(cfg.limits[k]);
    });
  }

  function resumeKey(kind, f) { return 'sg-up:' + kind + ':' + f.name + ':' + f.size + ':' + f.lastModified; }

  function startSession(kind, f, title, note) {
    var key = resumeKey(kind, f);
    var old = tryStore(function () { return localStorage.getItem(key); });
    function create() {
      return net(function () { return api('POST', '/api/uploads', { kind: kind, fileName: f.name, size: f.size, title: title, note: note }); }).then(function (s) {
        tryStore(function () { localStorage.setItem(key, s.uploadId); });
        return s;
      });
    }
    if (!old) return create();
    return net(function () { return api('GET', '/api/uploads/' + old); }).catch(function (e) {
      if (e && e.status === 404) return null;
      throw e;
    }).then(function (s) { return s || create(); });
  }

  function uploadOne(kind, f, title, note, row) {
    var st = { cancelled: false, id: null };
    row.cancel.addEventListener('click', function () {
      st.cancelled = true;
      if (st.id) api('DELETE', '/api/uploads/' + st.id).catch(function () {});
      tryStore(function () { localStorage.removeItem(resumeKey(kind, f)); });
    });
    function paint(done) {
      var pct = Math.min(100, Math.floor(done / f.size * 100));
      row.fill.style.width = pct + '%';
      row.state.textContent = nf.format(pct) + '% · ' + fmtSize(done) + ' / ' + fmtSize(f.size);
    }
    return startSession(kind, f, title, note).then(function (s) {
      st.id = s.uploadId;
      var CH = s.chunkSize;
      var have = {}; (s.received || []).forEach(function (i) { have[i] = true; });
      var todo = [], done = 0;
      for (var i = 0; i < s.total; i++) {
        var len = Math.min(CH, f.size - i * CH);
        if (have[i]) done += len; else todo.push(i);
      }
      paint(done);
      if (done > 0 && todo.length) row.state.textContent += ' · আগের জায়গা থেকে চলছে';
      var failure = null;
      function sendChunk(i) {
        var a = i * CH, b = Math.min(f.size, a + CH);
        var attempt = 0;
        function go() {
          return net(function () { return api('PUT', '/api/uploads/' + s.uploadId + '/' + i, null, f.slice(a, b)); }).then(function () {
            done += b - a; paint(done);
          }).catch(function (e) {
            attempt++;
            var retryable = !e || e.status === 0 || e.status >= 500;
            if (!retryable || attempt >= 5 || st.cancelled) throw e;
            return wait(Math.min(8000, 700 * Math.pow(2, attempt))).then(go);
          });
        }
        return go();
      }
      function worker() {
        if (failure || st.cancelled || !todo.length) return Promise.resolve();
        return sendChunk(todo.shift()).then(worker).catch(function (e) { failure = failure || e; });
      }
      return Promise.all([worker(), worker(), worker()]).then(function () {
        if (st.cancelled) throw { cancelled: true };
        if (failure) throw failure;
        row.state.textContent = 'শেষ করা হচ্ছে…';
        return net(function () { return api('POST', '/api/uploads/' + s.uploadId + '/complete'); });
      });
    }).then(function () {
      tryStore(function () { localStorage.removeItem(resumeKey(kind, f)); });
    });
  }

  function progressRow(list, name) {
    var fill = h('i'); var state = h('span', { class: 'st', text: 'শুরু হচ্ছে…' });
    var cancel = h('button', { type: 'button', class: 'btn ghost sm', text: 'বন্ধ করুন' });
    var li = h('li', { class: 'up', 'data-state': 'run' },
      h('div', { class: 'row1' }, h('span', { class: 'nm', text: name }), state),
      h('div', { class: 'bar' }, fill), h('div', { class: 'ctl' }, cancel));
    list.appendChild(li);
    return { li: li, fill: fill, state: state, cancel: cancel };
  }

  function submitFiles(kind, form, input, picked, progress) {
    if (busy[kind]) return;
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) { setMsg(kind, 'আগে একটি ফাইল বেছে নিন।', 'err'); return; }
    var bad = files.filter(function (f) { return validateFile(kind, f); });
    if (bad.length) { setMsg(kind, 'লাল চিহ্নিত ফাইল বাদ দিয়ে আবার চেষ্টা করুন।', 'err'); return; }
    var title = files.length === 1 ? $('title-' + kind).value.trim() : '';
    var note = $('note-' + kind).value.trim();
    busy[kind] = true; $('btn-' + kind).disabled = true; setMsg(kind, '', 'info');
    clear(progress);
    var okCount = 0, badCount = 0, lastErr = '';
    // পাতা ছেড়ে গেলে আপলোড থেমে যায়, তাই সাবধান করা হয়
    function warn(e) { e.preventDefault(); e.returnValue = ''; }
    window.addEventListener('beforeunload', warn);
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        var row = progressRow(progress, f.name);
        return uploadOne(kind, f, title, note, row).then(function () {
          okCount++; row.li.setAttribute('data-state', 'ok'); row.state.textContent = 'যোগ হয়েছে'; row.cancel.hidden = true;
        }).catch(function (e) {
          row.cancel.hidden = true;
          if (e && e.cancelled) { row.li.setAttribute('data-state', 'err'); row.state.textContent = 'বন্ধ করা হয়েছে'; return; }
          badCount++; lastErr = errText(e);
          row.li.setAttribute('data-state', 'err'); row.state.textContent = errText(e);
        });
      });
    });
    chain.then(function () {
      window.removeEventListener('beforeunload', warn);
      if (okCount) { form.reset(); clear(picked); }
      if (okCount && !badCount) { setMsg(kind, nf.format(okCount) + 'টি ফাইল যোগ হয়েছে।', 'ok'); toast(nf.format(okCount) + 'টি ফাইল যোগ হয়েছে'); }
      else if (okCount) setMsg(kind, nf.format(okCount) + 'টি যোগ হয়েছে, ' + nf.format(badCount) + 'টি হয়নি।', 'err');
      else if (badCount) setMsg(kind, lastErr + ' সংযোগ কেটে গেলে একই ফাইল আবার বেছে নিলে আগের জায়গা থেকে চলবে।', 'err');
      busy[kind] = false; $('btn-' + kind).disabled = false;
      return refresh();
    });
  }

  /* ---------- admin ---------- */
  function paintAdmin() {
    els.adminBtn.textContent = admin ? 'অ্যাডমিন মোড · বের হন' : 'অ্যাডমিন';
  }
  function initAdmin() {
    els.adminBtn.addEventListener('click', function () {
      if (admin) {
        net(function () { return api('POST', '/api/logout'); }).then(function () { admin = false; pendingDelete = null; paintAdmin(); renderAll(); toast('অ্যাডমিন থেকে বের হয়েছেন'); }).catch(function () { toast('বের হওয়া যায়নি'); });
        return;
      }
      els.loginPanel.hidden = !els.loginPanel.hidden;
      if (!els.loginPanel.hidden) { $('admin-pw').focus(); }
    });
    $('login-cancel').addEventListener('click', function () { els.loginPanel.hidden = true; $('admin-pw').value = ''; $('login-msg').textContent = ''; });
    els.loginPanel.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = $('admin-pw').value;
      if (!pw) { $('login-msg').textContent = 'পাসওয়ার্ড লিখুন।'; $('login-msg').setAttribute('data-tone', 'err'); return; }
      $('login-go').disabled = true;
      net(function () { return api('POST', '/api/login', { password: pw }); }).then(function () {
        admin = true; $('admin-pw').value = ''; $('login-msg').textContent = ''; els.loginPanel.hidden = true;
        paintAdmin(); renderAll(); toast('অ্যাডমিন হিসেবে ঢুকেছেন');
      }).catch(function (err) {
        $('login-msg').textContent = errText(err); $('login-msg').setAttribute('data-tone', 'err');
      }).then(function () { $('login-go').disabled = false; });
    });
    paintAdmin();
  }

  /* ---------- delete (শুধু অ্যাডমিন) ---------- */
  function removeItem(it) {
    pendingDelete = null;
    net(function () { return api('DELETE', '/api/items/' + it.id); }).then(function () { toast('মুছে ফেলা হয়েছে'); return refresh(); }).catch(function (e) {
      if (e && e.status === 401) { admin = false; paintAdmin(); }
      toast(errText(e)); renderAll();
    });
    renderAll();
  }
  function deleteControl(it) {
    if (!admin) return null;
    if (pendingDelete === it.id) {
      return h('span', { class: 'confirm' }, 'মুছে ফেলবেন?',
        h('button', { type: 'button', class: 'btn danger sm', onclick: function () { removeItem(it); } }, 'হ্যাঁ, মুছুন'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: function () { pendingDelete = null; renderAll(); } }, 'থাক'));
    }
    return h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': it.title + ' মুছুন', onclick: function () { pendingDelete = it.id; renderAll(); } }, 'মুছুন');
  }

  /* ---------- lists ---------- */
  function filtered(kind) {
    var q = ui[kind].q.trim().toLowerCase();
    var list = ofKind(kind).filter(function (i) {
      return !q || [i.title, i.note, i.url, i.fileName].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var s = ui[kind].sort;
    list.sort(function (a, b) {
      if (s === 'old') return (a.createdAt || 0) - (b.createdAt || 0);
      if (s === 'name') return String(a.title || '').localeCompare(String(b.title || ''), 'bn');
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    return list;
  }
  function emptyBox(kind, searching) {
    var c = KINDS[kind];
    if (!loaded) return h('div', { class: 'empty' }, h('strong', { text: failedLoad ? 'সংগ্রহ আনা যায়নি' : 'লোড হচ্ছে…' }), failedLoad ? h('span', { text: 'পাতাটি রিলোড করুন বা একটু পরে চেষ্টা করুন।' }) : null);
    if (searching) return h('div', { class: 'empty' }, h('strong', { text: 'কিছু মেলেনি' }), h('span', { text: 'অন্য শব্দ দিয়ে খুঁজে দেখুন।' }));
    return h('div', { class: 'empty' }, h('strong', { text: c.emptyTitle }), h('span', { text: c.emptyText }));
  }
  function renderList(kind) {
    var host = $('list-' + kind); if (!host) return;
    clear(host);
    var list = filtered(kind);
    if (!list.length) { host.appendChild(emptyBox(kind, ofKind(kind).length > 0)); return; }
    if (kind === 'links') host.appendChild(h('ul', { class: 'rows' }, list.map(linkRow)));
    else if (kind === 'videos') host.appendChild(h('ul', { class: 'cards' }, list.map(videoCard)));
    else if (kind === 'images') host.appendChild(h('ul', { class: 'cards imgs' }, list.map(function (it, i) { return imageCard(it, i, list); })));
    else host.appendChild(h('ul', { class: 'rows' }, list.map(pdfRow)));
  }
  function linkRow(it) {
    var href = safeHttp(it.url);
    var host = ''; try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
    return h('li', { class: 'row k-links' },
      h('span', { class: 'chip' }, icon('links')),
      h('div', { class: 'body' },
        h('div', { class: 'title' }, href ? h('a', { href: href, target: '_blank', rel: 'noopener noreferrer nofollow ugc', text: it.title || host }) : (it.title || 'লিংক')),
        h('div', { class: 'sub', text: host + (it.createdAt ? ' · ' + fmtDate(it.createdAt) : '') }),
        it.note ? h('div', { class: 'note', text: it.note }) : null),
      h('div', { class: 'side' }, href ? h('a', { class: 'btn ghost sm', href: href, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, 'খুলুন') : null, deleteControl(it)));
  }
  function videoCard(it) {
    return h('li', { class: 'card k-videos' },
      h('video', { controls: true, preload: 'metadata', playsinline: true, src: it.src, 'aria-label': it.title || 'ভিডিও' }),
      h('div', { class: 'cap' },
        h('div', { class: 'title', text: it.title || 'ভিডিও' }),
        h('div', { class: 'sub', text: (it.size ? fmtSize(it.size) + ' · ' : '') + fmtDate(it.createdAt) }),
        it.note ? h('div', { class: 'note', text: it.note }) : null,
        admin ? h('div', { class: 'ctl' }, deleteControl(it)) : null));
  }
  function imageCard(it, idx, list) {
    var thumb = h('button', { type: 'button', class: 'thumb', 'aria-label': (it.title || 'ছবি') + ' বড় করে দেখুন', onclick: function () { openLightbox(list, idx); } },
      h('img', { src: it.src, alt: it.title || 'ছবি', loading: 'lazy' }));
    return h('li', { class: 'card k-images' }, thumb,
      h('div', { class: 'cap' },
        h('div', { class: 'title', text: it.title || 'ছবি' }),
        h('div', { class: 'sub', text: (it.size ? fmtSize(it.size) + ' · ' : '') + fmtDate(it.createdAt) }),
        it.note ? h('div', { class: 'note', text: it.note }) : null,
        admin ? h('div', { class: 'ctl' }, deleteControl(it)) : null));
  }
  function pdfRow(it) {
    return h('li', { class: 'row k-pdfs' },
      h('span', { class: 'chip' }, icon('pdfs')),
      h('div', { class: 'body' },
        h('div', { class: 'title' }, h('a', { href: it.src, target: '_blank', rel: 'noopener noreferrer', text: it.title || 'পিডিএফ' })),
        h('div', { class: 'sub', text: [it.fileName, it.size ? fmtSize(it.size) : '', fmtDate(it.createdAt)].filter(Boolean).join(' · ') }),
        it.note ? h('div', { class: 'note', text: it.note }) : null),
      h('div', { class: 'side' }, h('a', { class: 'btn ghost sm', href: it.src, target: '_blank', rel: 'noopener noreferrer' }, 'খুলুন'), deleteControl(it)));
  }

  /* ---------- lightbox ---------- */
  var lb = { list: [], i: 0, opener: null };
  function paintLightbox() {
    var it = lb.list[lb.i]; if (!it) return;
    els.lbImg.src = it.src; els.lbImg.alt = it.title || 'ছবি';
    els.lbCap.textContent = (it.title || 'ছবি') + ' · ' + nf.format(lb.i + 1) + '/' + nf.format(lb.list.length);
    els.lbPrev.disabled = lb.i <= 0; els.lbNext.disabled = lb.i >= lb.list.length - 1;
  }
  function openLightbox(list, i) { lb.list = list; lb.i = i; lb.opener = document.activeElement; els.lb.hidden = false; paintLightbox(); els.lbClose.focus(); }
  function closeLightbox() { els.lb.hidden = true; els.lbImg.removeAttribute('src'); if (lb.opener && lb.opener.focus) { try { lb.opener.focus(); } catch (e) { /* ignore */ } } }
  function initLightbox() {
    els.lbClose.addEventListener('click', closeLightbox);
    els.lbPrev.addEventListener('click', function () { if (lb.i > 0) { lb.i--; paintLightbox(); } });
    els.lbNext.addEventListener('click', function () { if (lb.i < lb.list.length - 1) { lb.i++; paintLightbox(); } });
    els.lb.addEventListener('click', function (e) { if (e.target === els.lb || e.target.classList.contains('stage')) closeLightbox(); });
    document.addEventListener('keydown', function (e) {
      if (els.lb.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') els.lbPrev.click();
      else if (e.key === 'ArrowRight') els.lbNext.click();
    });
  }

  /* ---------- home ---------- */
  function renderHome() {
    var grid = $('sum-grid'); clear(grid);
    ORDER.forEach(function (k) {
      var list = ofKind(k).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      var latest = list[0];
      grid.appendChild(h('div', { class: 'sum k-' + k },
        h('div', { class: 'sum-head' }, h('span', { class: 'chip' }, icon(k)), h('h3', { text: KINDS[k].label })),
        h('div', { class: 'big', text: nf.format(list.length) }),
        h('div', { class: 'latest', text: latest ? 'সর্বশেষ: ' + (latest.title || '') : (loaded ? 'এখনো কিছু নেই' : 'লোড হচ্ছে…') }),
        h('a', { class: 'go', href: '#' + k }, KINDS[k].label + ' দেখুন →')));
    });
    var rec = $('recent'); clear(rec);
    var recent = items.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, 8);
    if (!recent.length) rec.appendChild(h('li', null, h('span', { class: 't', text: loaded ? 'এখনো কিছু যোগ করা হয়নি।' : 'লোড হচ্ছে…' })));
    recent.forEach(function (it) {
      if (!KINDS[it.kind]) return;
      rec.appendChild(h('li', { class: 'k-' + it.kind },
        h('span', { class: 'chip' }, icon(it.kind)),
        h('a', { class: 't', href: '#' + it.kind, text: it.title || KINDS[it.kind].one }),
        h('span', { class: 'd', text: fmtDate(it.createdAt) })));
    });
    var m = $('meter');
    if (admin && cfg.total) {
      m.hidden = false; clear(m);
      var used = items.reduce(function (n, i) { return n + (i.size || 0); }, 0);
      var bar = h('div', { class: 'bar' }, h('i'));
      bar.firstChild.style.width = Math.min(100, Math.round(used / cfg.total * 100)) + '%';
      m.appendChild(h('span', { text: 'সংরক্ষণ: ' + fmtSize(used) + ' / ' + fmtSize(cfg.total) + ' ব্যবহৃত' })); m.appendChild(bar);
    } else m.hidden = true;
  }

  function renderAll() {
    ORDER.forEach(function (k) {
      var n = ofKind(k).length;
      var c = $('cnt-' + k); if (c) c.textContent = loaded ? nf.format(n) : '–';
      var hc = $('head-count-' + k); if (hc) hc.textContent = loaded ? nf.format(n) + 'টি' : '';
      renderList(k);
    });
    renderHome(); paintHints();
    var b = $('banner');
    if (failedLoad && !loaded) { b.hidden = false; b.textContent = 'সার্ভারের সঙ্গে সংযোগ হয়নি। ইন্টারনেট দেখে পাতাটি রিলোড করুন।'; }
    else b.hidden = true;
  }

  /* ---------- init ---------- */
  function init() {
    els.tabs = $('tabs'); els.themeBtn = $('theme-btn'); els.adminBtn = $('admin-btn'); els.loginPanel = $('login-panel');
    els.lb = $('lb'); els.lbImg = $('lb-img'); els.lbCap = $('lb-cap'); els.lbPrev = $('lb-prev'); els.lbNext = $('lb-next'); els.lbClose = $('lb-close');
    var app = $('app');
    VIEWS.forEach(function (v) {
      var sec = h('section', { id: 'view-' + v, class: 'view', 'aria-label': v === 'home' ? 'সারসংক্ষেপ' : KINDS[v].label, hidden: true });
      els['view-' + v] = sec; app.appendChild(sec);
    });
    buildTabs(); buildHome(); ORDER.forEach(buildSection);
    initTheme(); initLightbox(); initAdmin();
    window.addEventListener('hashchange', showView);
    showView(); renderAll();
    loadConfig().then(function () { paintAdmin(); return refresh(); });
    setInterval(function () { if (!document.hidden && !Object.keys(busy).some(function (k) { return busy[k]; })) loadItems().then(function () { paintAdmin(); renderAll(); }); }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
