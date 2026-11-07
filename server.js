'use strict';

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
  pdfs: (Number(process.env.MAX_PDF_MB) || 200) * MB
};
const MAX_TOTAL = (Number(process.env.MAX_TOTAL_GB) || 100) * MB * 1024;
const UPLOADS_PER_HOUR = (Number(process.env.UPLOADS_PER_HOUR) || 20);
const LINKS_PER_HOUR = (Number(process.env.LINKS_PER_HOUR) || 100);

const TYPES = {
  videos: { mp4: 'video/mp4', webm: 'video/webm' },
  images: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' },
  pdfs: { pdf: 'application/pdf' }
};

const ALL_MIME = {};
Object.keys(TYPES).forEach(k => Object.assign(ALL_MIME, TYPES[k]));

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf'
};

async function initDb() {
  fs.mkdirSync(FILES, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  let generated = false;

  if (!ADMIN_PASSWORD) {
    const pf = path.join(DATA, 'admin-password.txt');
    try {
      ADMIN_PASSWORD = fs.readFileSync(pf, 'utf-8').trim();
    } catch (e) {}

    if (!ADMIN_PASSWORD) {
      ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
      fs.writeFileSync(pf, ADMIN_PASSWORD + '\n', 'utf-8');
      generated = true;
    }
  }

  const PW_HASH = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');

  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {}

  let saveChain = Promise.resolve();

  function saveItems() {
    saveChain = saveChain.then(async () => {
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(items, null, 2), 'utf-8');
      await fsp.rename(tmp, DB_FILE);
    }).catch((e) => console.error('সংরক্ষণ ব্যর্থ:', e));
    return saveChain;
  }

  function publicItem(it) {
    return {
      id: it.id,
      kind: it.kind,
      title: it.title,
      url: it.url,
      src: it.file ? '/files/' + it.file : undefined,
      created: it.created,
      updated: it.updated
    };
  }

  function usedBytes() {
    let n = 0;
    for (const it of items) n += it.size || 0;
    for (const u of pending.values()) n += u.received.reduce((a, b) => a + b, 0);
    return n;
  }

  const pending = new Map();

  function metaPath(id) { return path.join(TMP, id + '.meta'); }
  function partPath(id) { return path.join(TMP, id + '.part'); }

  function persistMeta(u) {
    u.lock = (u.lock || Promise.resolve()).then(async () => {
      await fsp.writeFile(metaPath(u.id), JSON.stringify({
        id: u.id,
        fileName: u.fileName,
        kind: u.kind,
        title: u.title,
        total: u.total,
        expected: u.expected,
        created: u.created,
        received: u.received
      }, null, 2), 'utf-8');
    }).catch(() => {});
    return u.lock;
  }

  try {
    for (const f of fs.readdirSync(TMP)) {
      if (!f.endsWith('.meta')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf-8'));
        if (m && typeof m.id === 'string' && /^[a-f0-9]{24}$/.test(m.id)) {
          m.lock = Promise.resolve();
          m.received = (m.received || []).map(Number);
          pending.set(m.id, m);
        }
      } catch (e) {}
    }
  } catch (e) {}

  function dropPending(id) {
    pending.delete(id);
    try { fs.unlinkSync(partPath(id)); } catch (e){}
    try { fs.unlinkSync(metaPath(id)); } catch (e){}
  }

  setInterval(() => {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const u of pending.values()) {
      if ((u.created || 0) < cutoff) dropPending(u.id);
    }
  }, 3600 * 1000).unref();

  const hits = new Map();

  function limited(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return true;
    }
    arr.push(now);
    hits.set(key, arr);
    return false;
  }

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      const filtered = v.filter(t => now - t < 10 * 60 * 1000);
      if (filtered.length === 0) hits.delete(k);
      else hits.set(k, filtered);
    }
  }, 10 * 60 * 1000).unref();

  function clientIp(req) {
    if (TRUST_PROXY) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function send(res, status, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }

  function fail(res, status, error) {
    send(res, status, { error: error });
  }

  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const parts = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > max) {
          req.destroy();
          reject(new Error('Payload too large'));
          return;
        }
        parts.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  async function readJson(req) {
    const buf = await readBody(req, 64 * 1024);
    try {
      return JSON.parse(buf.toString('utf-8'));
    } catch (e) {
      throw new Error('Invalid JSON');
    }
  }

  const cleanText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  function safeHttp(u) {
    try {
      const p = new URL(u, 'http://x');
      if (p.protocol === 'http:' || p.protocol === 'https:') return p.href;
    } catch(e) {}
    return undefined;
  }

  const sessions = new Map();

  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return out;
  }

  function isAdmin(req) {
    const t = parseCookies(req).sid;
    if (!t) return false;
    const exp = sessions.get(t);
    if (!exp || exp < Date.now()) {
      sessions.delete(t);
      return false;
    }
    return true;
  }

  function cookie(token, maxAge) {
    return 'sid=' + token + '; HttpOnly; SameSite=Strict' + (COOKIE_SECURE ? '; Secure' : '');
  }

  async function magicOk(file, ext) {
    const fh = await fsp.open(file, 'r');
    try {
      const b = Buffer.alloc(16);
      await fh.read(b, 0, 16, 0);
      if (ext === 'png') return b.slice(0, 4).toString('hex') === '89504e47';
      if (ext === 'jpg' || ext === 'jpeg') return b.slice(0, 3).toString('hex') === 'ffd8ff';
      if (ext === 'gif') return b.slice(0, 3).toString('hex') === '474946';
      if (ext === 'webp') return b.slice(0, 4).toString('hex') === '52494646';
      if (ext === 'pdf') return b.slice(0, 4).toString('hex') === '25504446';
      if (ext === 'mp4') return b.slice(4, 12).toString('hex').includes('66747970');
      if (ext === 'webm') return b.slice(0, 4).toString('hex') === '1a45dfa3';
      return false;
    } finally {
      await fh.close();
    }
  }

  async function api(req, res, url) {
    const method = req.method;
    const p = url.pathname;
    const ip = clientIp(req);

    if (method !== 'GET' && method !== 'HEAD' && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).hostname !== new URL(`http://${req.headers.host || 'localhost'}`).hostname) {
            res.writeHead(403);
            return res.end();
          }
        } catch(e) {
          res.writeHead(403);
          return res.end();
        }
      }
    }

    if (method === 'GET' && p === '/api/config') {
      const used = usedBytes();
      const ret = {
        chunkSize: CHUNK,
        limits: LIMITS,
        types: Object.keys(TYPES).reduce((acc, k) => {
          acc[k] = Object.keys(TYPES[k]);
          return acc;
        }, {}),
        used: used,
        total: MAX_TOTAL
      };
      const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };
      const body = JSON.stringify(ret);
      res.writeHead(200, Object.assign(headers, { 'Content-Length': Buffer.byteLength(body) }));
      return res.end(body);
    }

    if (method === 'GET' && p === '/api/items') {
      const out = items.map(publicItem);
      const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };
      const body = JSON.stringify(out);
      res.writeHead(200, Object.assign(headers, { 'Content-Length': Buffer.byteLength(body) }));
      return res.end(body);
    }

    if (method === 'POST' && p === '/api/login') {
      if (limited('login:' + ip, 10, 15 * 60 * 1000)) return fail(res, 429, 'ratelimit');
      let body;
      try { body = await readJson(req); } catch (e) { return fail(res, 400, 'json'); }
      const given = crypto.createHash('sha256').update(String(body.password || '')).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(PW_HASH, 'hex'))) {
        return fail(res, 401, 'auth');
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 12 * 3600 * 1000);
      res.setHeader('Set-Cookie', cookie(token, 12 * 3600));
      return send(res, 200, { admin: true });
    }

    if (method === 'POST' && p === '/api/logout') {
      const t = parseCookies(req).sid;
      if (t) sessions.delete(t);
      res.setHeader('Set-Cookie', cookie('', 0));
      return send(res, 200, { admin: false });
    }

    if (method === 'POST' && p === '/api/links') {
      if (limited('link:' + ip, LINKS_PER_HOUR, 3600 * 1000)) return fail(res, 429, 'ratelimit');
      let body;
      try { body = await readJson(req); } catch (e) { return fail(res, 400, 'json'); }
      const href = safeHttp(body.url);
      if (!href || href.length > 2000) return fail(res, 400, 'url');
      if (items.some((i) => i.kind === 'link' && i.url === href)) return fail(res, 400, 'duplicate');
      let host = '';
      try { host = new URL(href).host; } catch (e) {}
      const it = {
        id: crypto.randomBytes(8).toString('hex'),
        kind: 'link',
        title: cleanText(body.title, 100) || host || 'Link',
        url: href,
        created: Date.now()
      };
      items.push(it);
      await saveItems();
      return send(res, 201, { item: publicItem(it) });
    }

    if (method === 'POST' && p === '/api/uploads') {
      const kind = String(req.headers['x-file-kind'] || '');
      const title = cleanText(req.headers['x-file-title'] || '', 100);
      const fileName = cleanText(req.headers['x-upload-filename'] || '', 150);

      if (!TYPES.hasOwnProperty(kind)) return fail(res, 400, 'kind');
      const ext = path.extname(fileName).slice(1).toLowerCase();
      if (!TYPES[kind].hasOwnProperty(ext)) return fail(res, 400, 'type');
      const size = Number(req.headers['x-file-size']);
      if (!Number.isInteger(size) || size <= 0 || size > LIMITS[kind]) return fail(res, 400, 'size');
      if (size + usedBytes() > MAX_TOTAL) return fail(res, 400, 'quota');
      if (pending.size >= 300) return fail(res, 400, 'busy');
      if (limited('up:' + ip, UPLOADS_PER_HOUR, 3600 * 1000)) return fail(res, 429, 'ratelimit');

      const u = {
        id: crypto.randomBytes(12).toString('hex'),
        fileName: fileName,
        kind: kind,
        title: title || 'File',
        total: size,
        expected: Math.ceil(size / CHUNK),
        received: [],
        created: Date.now(),
        touched: Date.now()
      };
      await fsp.writeFile(partPath(u.id), '');
      pending.set(u.id, u);
      await persistMeta(u);
      return send(res, 201, { uploadId: u.id, chunkSize: CHUNK });
    }

    const m = /^\/api\/uploads\/([a-f0-9]{24})\/?(.*)$/.exec(p);
    if (m) {
      const u = pending.get(m[1]);
      if (!u) return fail(res, 404, 'not_found');
      u.touched = Date.now();
      const sub = m[2];

      if (method === 'GET' && !sub) return send(res, 201, { uploadId: u.id, received: u.received, done: u.received.length === u.expected });
      if (method === 'DELETE' && !sub) {
        dropPending(u.id);
        return send(res, 200, { ok: true });
      }

      const ext = path.extname(u.fileName).slice(1).toLowerCase();

      if (method === 'PUT' && sub && sub !== 'finish') {
        const index = Number(sub);
        const chunkCount = Math.ceil(u.total / CHUNK);
        if (!Number.isInteger(index) || index < 0 || index >= chunkCount) return fail(res, 400, 'index');
        const expectedEnd = index === chunkCount - 1 ? u.total : (index + 1) * CHUNK;
        const expectedLen = expectedEnd - index * CHUNK;
        const clen = Number(req.headers['content-length']);
        if (!Number.isInteger(clen) || clen !== expectedLen) return fail(res, 400, 'len');
        const buf = await readBody(req, expectedLen);
        if (buf.length !== expectedLen) return fail(res, 400, 'len');
        const fh = await fsp.open(partPath(u.id), 'r+');
        try {
          await fh.write(buf, 0, expectedLen, index * CHUNK);
        } finally {
          await fh.close();
        }
        if (!u.received[index]) {
          u.received[index] = buf.length;
          await persistMeta(u);
        }
        return send(res, 200, { received: u.received });
      }

      if (method === 'POST' && sub === 'finish') {
        if (u.finished) return fail(res, 400, 'busy');
        if (u.received.reduce((a, b) => a + b, 0) !== u.total) return fail(res, 400, 'incomplete');
        u.finished = true;
        try {
          const part = partPath(u.id);
          const st = await fsp.stat(part);
          if (st.size !== u.total) throw new Error('size');
          if (!(await magicOk(part, ext))) throw new Error('type');
          const file = crypto.randomBytes(16).toString('hex') + '.' + ext;
          await fsp.rename(part, path.join(FILES, file));
          const it = {
            id: crypto.randomBytes(8).toString('hex'),
            kind: u.kind,
            title: u.title,
            file: file,
            fileName: u.fileName,
            size: u.total,
            created: Date.now()
          };
          items.push(it);
          await saveItems();
          dropPending(u.id);
          return send(res, 201, { item: publicItem(it) });
        } finally {
          delete u.finished;
        }
      }
      return fail(res, 405, 'method');
    }
    return fail(res, 404, 'not_found');
  }

  async function serveFile(req, res, name) {
    if (!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(name)) return fail(res, 404, 'not_found');
    const full = path.join(FILES, name);
    let st;
    try { st = await fsp.stat(full); } catch (e) { return fail(res, 404, 'not_found'); }
    const mime = STATIC_MIME[path.extname(name)] || 'application/octet-stream';
    const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000' };
    let start = 0, end = st.size - 1, status = 200;
    const range = req.headers.range;
    if (range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!r || (r[1] === '' && r[2] === '')) {}
      else if (r[1] === '') { start = Math.max(0, st.size - Number(r[2])); }
      else {
        start = Number(r[1]);
        if (r[2] !== '') end = Math.min(end, Number(r[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(full, { start, end });
    stream.on('error', () => res.destroy());
    stream.on('close', () => res.destroy());
    stream.pipe(res);
  }

  const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:;";

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    try { rel = decodeURIComponent(rel); } catch (e) { rel = '/index.html'; }
    let full = path.normalize(path.join(PUBLIC, rel));
    if (!full.startsWith(PUBLIC + path.sep)) {
      full = path.join(PUBLIC, 'index.html');
    }
    let st;
    try {
      st = await fsp.stat(full);
      if (st.isDirectory()) {
        full = path.join(PUBLIC, 'index.html');
        st = await fsp.stat(full);
      }
    } catch (e) {
      full = path.join(PUBLIC, 'index.html');
      try {
        st = await fsp.stat(full);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
      }
    }
    const ext = path.extname(full).toLowerCase();
    const type = STATIC_MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Security-Policy': CSP,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname.startsWith('/files/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          return res.end();
        }
        return await serveFile(req, res, url.pathname.slice(7));
      }
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e && e.status) return fail(res, e.status, e.message);
      if (e && e.message === 'Payload too large') return fail(res, 413, 'payload');
      console.error(e);
      fail(res, 500, 'server_error');
    }
  });

  server.requestTimeout = 0;
  server.headerTimeout = 30000;
  server.keepAliveTimouts = { headTimeout: 30000, requestTimeout: 0 };

  server.listen(PORT, HOST, () => {
    console.log(`চালু হয়েছে: http://localhost:${PORT}`);
    console.log(`ভিডিও সর্বোচ্চ ${LIMITS.videos / MB} এমবি, ছবি ${LIMITS.images / MB} এমবি, পিডিএফ ${LIMITS.pdfs / MB} এমবি, মোট ${MAX_TOTAL / MB} এমবি`);
    if (generated) console.log(`অ্যাডমিন পাসওয়ার্ড (নিজে ঠিক করতে ADMIN_PASSWORD দিন): ${ADMIN_PASSWORD}`);
    else console.log('অ্যাডমিন পাসওয়ার্ড: আপনার দেওয়া মান ব্যবহার হচ্ছে');
  });
}

initDb();
