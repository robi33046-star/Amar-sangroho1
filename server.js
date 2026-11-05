'use strict';
/*
 * আমার সংগ্রহ: ছোট, কোনো বাইরের প্যাকেজ ছাড়া Node সার্ভার।
 *  - সবাই লিংক যোগ করতে এবং ভিডিও/ছবি/পিডিএফ আপলোড করতে পারে।
 *  - মোছা যায় শুধু অ্যাডমিন পাসওয়ার্ড দিয়ে লগইন করলে।
 *  - বড় ফাইল ৮ এমবির টুকরোয় আপলোড হয়, নেট কেটে গেলে যেখান থেকে থেমেছিল সেখান থেকে চলে।
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const FILES = path.join(DATA, 'files');
const TMP = path.join(DATA, 'tmp');
const DB_FILE = path.join(DATA, 'items.json');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

const MB = 1024 * 1024;
const CHUNK = 8 * MB;
const LIMITS = {
  videos: (Number(process.env.MAX_VIDEO_MB) || 2048) * MB,
  images: (Number(process.env.MAX_IMAGE_MB) || 50) * MB,
  pdfs: (Number(process.env.MAX_PDF_MB) || 200) * MB,
};
const MAX_TOTAL = (Number(process.env.MAX_TOTAL_GB) || 100) * 1024 * MB;
const UPLOADS_PER_HOUR = Number(process.env.UPLOADS_PER_HOUR) || 30;
const LINKS_PER_HOUR = Number(process.env.LINKS_PER_HOUR) || 60;

const TYPES = {
  videos: { mp4: 'video/mp4', webm: 'video/webm' },
  images: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' },
  pdfs: { pdf: 'application/pdf' },
};
const ALL_MIME = {};
Object.keys(TYPES).forEach((k) => Object.assign(ALL_MIME, TYPES[k]));

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

/* ---------- admin password ---------- */
fs.mkdirSync(FILES, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let generated = false;
if (!ADMIN_PASSWORD) {
  const pf = path.join(DATA, 'admin-password.txt');
  try { ADMIN_PASSWORD = fs.readFileSync(pf, 'utf8').trim(); } catch (e) { /* none yet */ }
  if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(pf, ADMIN_PASSWORD + '\n', { mode: 0o600 });
    generated = true;
  }
}
const PW_HASH = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();

/* ---------- items store ---------- */
let items = [];
try { items = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (!Array.isArray(items)) items = []; } catch (e) { items = []; }
let saveChain = Promise.resolve();
function saveItems() {
  saveChain = saveChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(items));
    await fsp.rename(tmp, DB_FILE);
  }).catch((e) => console.error('সংরক্ষণ ব্যর্থ:', e.message));
  return saveChain;
}
function publicItem(it) {
  return {
    id: it.id, kind: it.kind, title: it.title, note: it.note, createdAt: it.createdAt,
    url: it.url, src: it.file ? '/files/' + it.file : undefined, fileName: it.fileName, size: it.size,
  };
}
function usedBytes() {
  let n = 0;
  for (const it of items) n += it.size || 0;
  for (const u of pending.values()) n += u.size;
  return n;
}

/* ---------- pending uploads ---------- */
const pending = new Map();
function metaPath(id) { return path.join(TMP, id + '.json'); }
function partPath(id) { return path.join(TMP, id + '.part'); }
function persistMeta(u) {
  u.lock = (u.lock || Promise.resolve()).then(() =>
    fsp.writeFile(metaPath(u.id), JSON.stringify({ ...u, lock: undefined, received: [...u.received] }))
  ).catch(() => {});
  return u.lock;
}
try {
  for (const f of fs.readdirSync(TMP)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8'));
      if (m && /^[a-f0-9]{24}$/.test(m.id) && fs.existsSync(partPath(m.id))) {
        m.received = new Set(m.received || []);
        pending.set(m.id, m);
      }
    } catch (e) { /* skip broken */ }
  }
} catch (e) { /* ignore */ }

async function dropPending(id) {
  pending.delete(id);
  await fsp.rm(partPath(id), { force: true });
  await fsp.rm(metaPath(id), { force: true });
}
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const u of pending.values()) if ((u.touched || u.created) < cutoff) dropPending(u.id).catch(() => {});
}, 3600 * 1000).unref();

/* ---------- small helpers ---------- */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) { if (!v.length || now - v[v.length - 1] > 3600 * 1000) hits.delete(k); }
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function fail(res, status, error) { send(res, status, { error }); }
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 64 * 1024);
  try { const v = JSON.parse(buf.toString('utf8') || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function safeHttp(u) {
  try { const p = new URL(String(u)); return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null; } catch (e) { return null; }
}

/* ---------- admin sessions ---------- */
const sessions = new Map();
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function isAdmin(req) {
  const t = parseCookies(req).sid;
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function cookie(token, maxAge) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` + (COOKIE_SECURE ? '; Secure' : '');
}

/* ---------- file checks ---------- */
async function magicOk(file, ext) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(16);
    await fh.read(b, 0, 16, 0);
    if (ext === 'png') return b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (ext === 'jpg' || ext === 'jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (ext === 'gif') return b.slice(0, 4).toString('latin1') === 'GIF8';
    if (ext === 'webp') return b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP';
    if (ext === 'pdf') return b.slice(0, 5).toString('latin1') === '%PDF-';
    if (ext === 'mp4') return b.slice(4, 8).toString('latin1') === 'ftyp';
    if (ext === 'webm') return b.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return false;
  } finally { await fh.close(); }
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const ip = clientIp(req);

  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers['x-requested-with'] !== 'sangroho') return fail(res, 403, 'forbidden');
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return fail(res, 403, 'forbidden'); } catch (e) { return fail(res, 403, 'forbidden'); } }
  }

  if (method === 'GET' && p === '/api/config') {
    return send(res, 200, {
      chunkSize: CHUNK, limits: LIMITS, admin: isAdmin(req),
      types: Object.fromEntries(Object.keys(TYPES).map((k) => [k, Object.keys(TYPES[k])])),
      used: usedBytes(), total: MAX_TOTAL,
    });
  }
  if (method === 'GET' && p === '/api/items') {
    return send(res, 200, { items: items.slice().sort((a, b) => b.createdAt - a.createdAt).map(publicItem), admin: isAdmin(req) });
  }

  if (method === 'POST' && p === '/api/login') {
    if (limited('login:' + ip, 10, 15 * 60 * 1000)) return fail(res, 429, 'too_many');
    const body = await readJson(req);
    const given = crypto.createHash('sha256').update(String(body.password || '')).digest();
    if (!crypto.timingSafeEqual(given, PW_HASH)) return fail(res, 401, 'wrong_password');
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + 12 * 3600 * 1000);
    res.setHeader('Set-Cookie', cookie(token, 12 * 3600));
    return send(res, 200, { admin: true });
  }
  if (method === 'POST' && p === '/api/logout') {
    const t = parseCookies(req).sid; if (t) sessions.delete(t);
    res.setHeader('Set-Cookie', cookie('', 0));
    return send(res, 200, { admin: false });
  }

  if (method === 'POST' && p === '/api/links') {
    if (limited('link:' + ip, LINKS_PER_HOUR, 3600 * 1000)) return fail(res, 429, 'too_many');
    const b = await readJson(req);
    const href = safeHttp(b.url);
    if (!href || href.length > 2000) return fail(res, 400, 'bad_url');
    if (items.some((i) => i.kind === 'links' && i.url === href)) return fail(res, 409, 'duplicate');
    let host = ''; try { host = new URL(href).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
    const it = { id: crypto.randomBytes(8).toString('hex'), kind: 'links', url: href, title: cleanText(b.title, 120) || host, note: cleanText(b.note, 300), createdAt: Date.now(), size: 0 };
    items.push(it); await saveItems();
    return send(res, 201, { item: publicItem(it) });
  }

  if (method === 'POST' && p === '/api/uploads') {
    const b = await readJson(req);
    const kind = String(b.kind || '');
    if (!TYPES[kind]) return fail(res, 400, 'bad_kind');
    const fileName = cleanText(b.fileName, 200);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (!TYPES[kind][ext]) return fail(res, 400, 'bad_type');
    const size = Number(b.size);
    if (!Number.isInteger(size) || size < 1) return fail(res, 400, 'empty');
    if (size > LIMITS[kind]) return fail(res, 413, 'too_large');
    if (usedBytes() + size > MAX_TOTAL) return fail(res, 507, 'storage_full');
    if (pending.size >= 300) return fail(res, 429, 'busy');
    if (limited('up:' + ip, UPLOADS_PER_HOUR, 3600 * 1000)) return fail(res, 429, 'too_many');
    const u = {
      id: crypto.randomBytes(12).toString('hex'), kind, fileName, ext, size,
      total: Math.ceil(size / CHUNK), received: new Set(),
      title: cleanText(b.title, 120) || fileName.replace(/\.[^.]+$/, ''), note: cleanText(b.note, 300),
      created: Date.now(), touched: Date.now(),
    };
    await fsp.writeFile(partPath(u.id), '');
    pending.set(u.id, u);
    await persistMeta(u);
    return send(res, 201, { uploadId: u.id, chunkSize: CHUNK, total: u.total, received: [] });
  }

  let m = /^\/api\/uploads\/([a-f0-9]{24})(?:\/(complete|\d+))?$/.exec(p);
  if (m) {
    const u = pending.get(m[1]);
    if (!u) return fail(res, 404, 'not_found');
    const sub = m[2];

    if (method === 'GET' && !sub) return send(res, 200, { uploadId: u.id, chunkSize: CHUNK, total: u.total, received: [...u.received] });

    if (method === 'DELETE' && !sub) { await dropPending(u.id); return send(res, 200, { ok: true }); }

    if (method === 'PUT' && sub && sub !== 'complete') {
      const index = Number(sub);
      if (!Number.isInteger(index) || index < 0 || index >= u.total) return fail(res, 400, 'bad_index');
      const expected = index < u.total - 1 ? CHUNK : u.size - (u.total - 1) * CHUNK;
      if (Number(req.headers['content-length']) !== expected) return fail(res, 400, 'bad_length');
      const buf = await readBody(req, expected);
      if (buf.length !== expected) return fail(res, 400, 'bad_length');
      const fh = await fsp.open(partPath(u.id), 'r+');
      try { await fh.write(buf, 0, buf.length, index * CHUNK); } finally { await fh.close(); }
      u.received.add(index); u.touched = Date.now();
      await persistMeta(u);
      return send(res, 200, { received: u.received.size, total: u.total });
    }

    if (method === 'POST' && sub === 'complete') {
      if (u.finishing) return fail(res, 409, 'busy');
      if (u.received.size !== u.total) return fail(res, 409, 'incomplete');
      u.finishing = true;
      try {
        const part = partPath(u.id);
        const st = await fsp.stat(part);
        if (st.size !== u.size) { u.received.clear(); await persistMeta(u); return fail(res, 409, 'size_mismatch'); }
        if (!(await magicOk(part, u.ext))) { await dropPending(u.id); return fail(res, 415, 'content_mismatch'); }
        const file = crypto.randomBytes(16).toString('hex') + '.' + u.ext;
        await fsp.rename(part, path.join(FILES, file));
        const it = { id: crypto.randomBytes(8).toString('hex'), kind: u.kind, file, fileName: u.fileName, title: u.title, note: u.note, size: u.size, createdAt: Date.now() };
        pending.delete(u.id);
        items.push(it); await saveItems();
        await fsp.rm(metaPath(u.id), { force: true });
        return send(res, 201, { item: publicItem(it) });
      } finally { u.finishing = false; }
    }
    return fail(res, 405, 'method');
  }

  // মোছা: শুধু অ্যাডমিন
  m = /^\/api\/items\/([a-f0-9]{16})$/.exec(p);
  if (m && method === 'DELETE') {
    if (!isAdmin(req)) return fail(res, 401, 'admin_only');
    const i = items.findIndex((x) => x.id === m[1]);
    if (i < 0) return fail(res, 404, 'not_found');
    const [it] = items.splice(i, 1);
    await saveItems();
    if (it.file) await fsp.rm(path.join(FILES, it.file), { force: true });
    return send(res, 200, { ok: true });
  }

  return fail(res, 404, 'not_found');
}

/* ---------- files with Range ---------- */
async function serveFile(req, res, name) {
  if (!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(name)) { res.writeHead(404); return res.end(); }
  const full = path.join(FILES, name);
  let st;
  try { st = await fsp.stat(full); } catch (e) { res.writeHead(404); return res.end(); }
  const mime = ALL_MIME[path.extname(name).slice(1)] || 'application/octet-stream';
  const headers = {
    'Content-Type': mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline',
  };
  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const r = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!r || (r[1] === '' && r[2] === '')) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    if (r[1] === '') { start = Math.max(0, st.size - Number(r[2])); }
    else { start = Number(r[1]); if (r[2] !== '') end = Math.min(end, Number(r[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(full, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/* ---------- static ---------- */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try { rel = decodeURIComponent(rel); } catch (e) { res.writeHead(400); return res.end(); }
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = await fsp.stat(full); if (!st.isFile()) throw new Error('x'); } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('পাওয়া যায়নি'); }
  const type = STATIC_MIME[path.extname(full)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/files/')) return await serveFile(req, res, url.pathname.slice(7));
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e && e.status) return fail(res, e.status, e.message);
    console.error(e);
    fail(res, 500, 'server_error');
  }
});
server.requestTimeout = 0;
server.headersTimeout = 30000;
server.keepAliveTimeout = 15000;
server.listen(PORT, HOST, () => {
  console.log(`চালু হয়েছে: http://localhost:${PORT}`);
  console.log(`ভিডিও সর্বোচ্চ ${LIMITS.videos / MB} এমবি, ছবি ${LIMITS.images / MB} এমবি, পিডিএফ ${LIMITS.pdfs / MB} এমবি, মোট ${MAX_TOTAL / 1024 / MB} জিবি`);
  if (generated) console.log(`অ্যাডমিন পাসওয়ার্ড (নিজে ঠিক করতে ADMIN_PASSWORD দিন): ${ADMIN_PASSWORD}\nএটি ${path.join(DATA, 'admin-password.txt')} ফাইলেও রাখা আছে।`);
  else console.log('অ্যাডমিন পাসওয়ার্ড: আপনার দেওয়া মান ব্যবহার হচ্ছে।');
});
