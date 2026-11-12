'use strict';

const path = require('path');
const ROOT = __dirname;
require('./lib/env').loadEnv(path.join(ROOT, '.env'));

const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { spawn } = require('child_process');

const files = require('./lib/files');
const zip = require('./lib/zip');
const { FsError } = files;

const SERVERS_DIR = path.join(ROOT, 'servers');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(SERVERS_DIR, '.tmp'); // satu filesystem dengan folder server (untuk rename atomik)
const DB_FILE = path.join(DATA_DIR, 'servers.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 200)) * 1024 * 1024;
const MAX_EXTRACT_BYTES = Math.max(1, Number(process.env.MAX_EXTRACT_MB || 1024)) * 1024 * 1024;
const MAX_ZIP_ENTRIES = Math.max(1, Number(process.env.MAX_ZIP_ENTRIES || 20000));
const ZIP_LIMITS = { ...zip.DEFAULT_LIMITS, maxTotalBytes: MAX_EXTRACT_BYTES, maxEntries: MAX_ZIP_ENTRIES };
const IS_WIN = process.platform === 'win32';

if (!PANEL_PASSWORD || PANEL_PASSWORD === 'change-this-to-a-long-password') {
  console.error('ERROR: Set PANEL_PASSWORD to a unique password before starting the panel (see .env.example).');
  process.exit(1);
}
if (!SESSION_SECRET || SESSION_SECRET === 'replace-this-with-a-long-random-secret') {
  console.error('ERROR: Set SESSION_SECRET to a long random value before starting the panel (see .env.example).');
  process.exit(1);
}

for (const dir of [SERVERS_DIR, DATA_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]\n');
// Bersihkan sisa staging dari proses yang pernah terhenti mendadak.
for (const name of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, name), { recursive: true, force: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.disable('x-powered-by');

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// Perlindungan CSRF tambahan: permintaan yang mengubah data harus berasal dari origin yang sama.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch {}
    if (!ok) return res.status(403).json({ error: 'Origin permintaan tidak diizinkan.' });
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
const sessionMiddleware = session({
  name: 'ptero_android_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 8 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

/* ------------------------------------------------------------------ util */

const MAX_LOG_LINES = 1000;
const procs = new Map();      // id -> child process
const meta = new Map();       // id -> { startedAt }
const lastExit = new Map();   // id -> { code, signal, at }
const logBuffers = new Map(); // id -> [{ seq, t, type, text }]
const logSeq = new Map();

const A = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

function readDb() {
  try {
    const value = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function writeDb(db) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n');
  fs.renameSync(tmp, DB_FILE);
}
function safeId(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value); }
function safeName(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,39}$/.test(value.trim()); }
const NAME_RULE = 'Nama 1-40 karakter. Gunakan huruf, angka, spasi, titik, _ atau -.';

function serverDir(id) {
  if (!safeId(id)) throw new FsError(400, 'ID server tidak valid.');
  const target = path.resolve(SERVERS_DIR, id);
  if (!target.startsWith(SERVERS_DIR + path.sep)) throw new FsError(400, 'Path tidak diizinkan.');
  return target;
}
function getServer(id) {
  if (!safeId(id)) return undefined;
  return readDb().find(item => item.id === id);
}
function requireServer(req) {
  const item = getServer(req.params.id);
  if (!item) throw new FsError(404, 'Server tidak ditemukan.');
  return item;
}
function isRunning(id) {
  const child = procs.get(id);
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}
function getStatus(id) { return isRunning(id) ? 'running' : 'offline'; }
function publicServer(item) {
  const running = isRunning(item.id);
  const m = meta.get(item.id);
  return {
    id: item.id,
    name: item.name,
    createdAt: item.createdAt,
    status: running ? 'running' : 'offline',
    pid: running ? procs.get(item.id).pid : null,
    startedAt: running && m ? m.startedAt : null,
    lastExit: lastExit.get(item.id) || null,
    directory: path.posix.join('servers', item.id)
  };
}
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Belum login atau sesi berakhir.' });
}
function bool(value) { return value === '1' || value === 'true' || value === true; }

/* ------------------------------------------------------------------- log */

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b[@-Z\\-_]/g;

function addLog(id, type, text) {
  if (String(text).trim() === '') return null; // lewati baris kosong (mis. header npm)
  const seq = (logSeq.get(id) || 0) + 1;
  logSeq.set(id, seq);
  const entry = { seq, t: Date.now(), type, text: String(text).replace(ANSI, '').replace(/\r/g, '') };
  const lines = logBuffers.get(id) || [];
  lines.push(entry);
  while (lines.length > MAX_LOG_LINES) lines.shift();
  logBuffers.set(id, lines);
  io.to(`server:${id}`).emit('log', { id, entry });
  return entry;
}

function lineSplitter(onLine) {
  let pending = '';
  let timer = null;
  const flush = () => { clearTimeout(timer); timer = null; if (pending) { onLine(pending); pending = ''; } };
  return {
    push(chunk) {
      pending += chunk.toString('utf8');
      const parts = pending.split(/\r?\n/);
      pending = parts.pop();
      for (const line of parts) onLine(line);
      clearTimeout(timer);
      // Prompt tanpa newline tetap ditampilkan setelah jeda singkat.
      if (pending) timer = setTimeout(flush, 150);
    },
    flush
  };
}

/* ------------------------------------------------------------- proses */

function killTree(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal); // grup proses (npm + node anak)
    }
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function emitStatus(id) {
  io.emit('server-status', {
    id,
    status: getStatus(id),
    pid: isRunning(id) ? procs.get(id).pid : null,
    startedAt: isRunning(id) ? (meta.get(id) || {}).startedAt || null : null,
    lastExit: lastExit.get(id) || null
  });
}

function startProcess(id) {
  const item = getServer(id);
  if (!item) throw new FsError(404, 'Server tidak ditemukan.');
  if (isRunning(id)) throw new FsError(409, 'Server sudah berjalan.');
  const cwd = serverDir(id);
  const packagePath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packagePath)) throw new FsError(400, 'package.json tidak ditemukan di folder server.');
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); }
  catch { throw new FsError(400, 'package.json tidak valid (bukan JSON yang benar).'); }
  if (!pkg.scripts || typeof pkg.scripts.start !== 'string' || !pkg.scripts.start.trim()) {
    throw new FsError(400, 'Tambahkan "scripts.start" di package.json terlebih dahulu.');
  }

  // Proses anak tidak boleh mewarisi rahasia panel.
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.PANEL_PASSWORD;
  delete env.SESSION_SECRET;

  addLog(id, 'sys', '$ npm start');
  const child = spawn(IS_WIN ? 'npm.cmd' : 'npm', ['start'], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WIN, detached: !IS_WIN, windowsHide: true
  });
  procs.set(id, child);
  meta.set(id, { startedAt: Date.now() });
  lastExit.delete(id);

  const out = lineSplitter(line => addLog(id, 'out', line));
  const err = lineSplitter(line => addLog(id, 'err', line));
  child.stdout.on('data', d => out.push(d));
  child.stderr.on('data', d => err.push(d));
  child.stdin.on('error', () => {});
  child.on('error', e => {
    addLog(id, 'err', `Gagal menjalankan proses: ${e.message}`);
    if (procs.get(id) === child) procs.delete(id);
    emitStatus(id);
  });
  child.on('close', (code, signal) => {
    out.flush(); err.flush();
    lastExit.set(id, { code, signal: signal || null, at: Date.now() });
    const clean = code === 0 || child.stopRequested;
    addLog(id, clean ? 'sys' : 'err', `Proses berhenti (kode=${code}, sinyal=${signal || '-'})${child.stopRequested ? ' - dihentikan dari panel' : ''}`);
    if (procs.get(id) === child) procs.delete(id);
    emitStatus(id);
  });
  emitStatus(id);
  return child;
}

function waitExit(id, timeoutMs) {
  return new Promise(resolve => {
    const child = procs.get(id);
    if (!child || !isRunning(id)) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(true); });
  });
}

function stopProcess(id) {
  const child = procs.get(id);
  if (!child || !isRunning(id)) throw new FsError(409, 'Server sedang offline.');
  child.stopRequested = true;
  addLog(id, 'sys', 'Mengirim sinyal berhenti (SIGTERM)...');
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (procs.get(id) === child && isRunning(id)) {
      addLog(id, 'sys', 'Proses belum berhenti, mengirim SIGKILL.');
      killTree(child, 'SIGKILL');
    }
  }, 5000);
  timer.unref();
}

/* ------------------------------------------------------------- statis */

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.use('/assets', express.static(path.join(ROOT, 'public', 'assets'), { maxAge: 0, etag: true }));
app.get('/favicon.ico', (req, res) => res.redirect('/assets/logo.jpg'));

/* --------------------------------------------------------------- auth */

const loginFails = new Map();
function loginLimited(ip) {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.first > 60 * 1000) { loginFails.delete(ip); return false; }
  return e.count >= 5;
}
function loginFailed(ip) {
  const e = loginFails.get(ip);
  if (!e || Date.now() - e.first > 60 * 1000) loginFails.set(ip, { count: 1, first: Date.now() });
  else e.count++;
}

app.get('/api/session', (req, res) => res.json({ authenticated: Boolean(req.session && req.session.authenticated) }));
app.post('/api/login', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (loginLimited(ip)) return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi dalam 1 menit.' });
  const supplied = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(PANEL_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    loginFailed(ip);
    return res.status(401).json({ error: 'Password salah.' });
  }
  loginFails.delete(ip);
  req.session.authenticated = true;
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/info', requireAuth, (req, res) => {
  res.json({ limits: { maxUploadBytes: MAX_UPLOAD_BYTES, maxExtractBytes: MAX_EXTRACT_BYTES, maxZipEntries: MAX_ZIP_ENTRIES } });
});

/* ------------------------------------------------------------- server */

app.get('/api/servers', requireAuth, (req, res) => res.json(readDb().map(publicServer)));

// Folder di servers/ yang belum terdaftar (mis. sisa "hapus konfigurasi saja" atau disalin manual).
app.get('/api/servers/orphans', requireAuth, A(async (req, res) => {
  const known = new Set(readDb().map(x => x.id));
  const dirents = await fsp.readdir(SERVERS_DIR, { withFileTypes: true });
  const list = dirents.filter(d => d.isDirectory() && safeId(d.name) && !known.has(d.name)).map(d => d.name).sort();
  res.json(list);
}));

app.get('/api/servers/:id', requireAuth, A((req, res) => res.json(publicServer(requireServer(req)))));

app.post('/api/servers', requireAuth, A(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!safeName(name)) throw new FsError(400, NAME_RULE);
  const db = readDb();
  if (db.some(x => x.name.toLowerCase() === name.toLowerCase())) throw new FsError(409, 'Sudah ada server dengan nama itu.');

  let id; let adopted = false;
  if (body.folder) {
    id = String(body.folder);
    if (!safeId(id)) throw new FsError(400, 'Nama folder tidak valid.');
    if (db.some(x => x.id === id)) throw new FsError(409, 'Folder itu sudah terdaftar sebagai server.');
    let st;
    try { st = await fsp.lstat(serverDir(id)); } catch { throw new FsError(404, 'Folder tidak ditemukan di servers/.'); }
    if (!st.isDirectory()) throw new FsError(400, 'Target bukan folder.');
    adopted = true;
  } else {
    id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server';
    const base = id; let n = 2;
    while (db.some(x => x.id === id) || fs.existsSync(serverDir(id))) id = `${base.slice(0, 35)}-${n++}`;
    const dir = serverDir(id);
    await fsp.mkdir(dir);
    if (body.template !== 'empty') {
      await fsp.writeFile(path.join(dir, 'index.js'), "console.log('Server berjalan!');\n", { flag: 'wx' });
      await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({
        name: id, version: '1.0.0', private: true, scripts: { start: 'node index.js' }
      }, null, 2) + '\n', { flag: 'wx' });
    }
  }
  const item = { id, name, createdAt: new Date().toISOString() };
  db.push(item);
  writeDb(db);
  addLog(id, 'sys', adopted ? 'Folder yang sudah ada ditambahkan sebagai server.' : 'Server dibuat. Edit file lalu tekan Start.');
  io.emit('servers-changed');
  res.json(publicServer(item));
}));

app.patch('/api/servers/:id', requireAuth, A((req, res) => {
  requireServer(req);
  const name = String((req.body && req.body.name) || '').trim();
  if (!safeName(name)) throw new FsError(400, NAME_RULE);
  const db = readDb();
  if (db.some(x => x.id !== req.params.id && x.name.toLowerCase() === name.toLowerCase())) throw new FsError(409, 'Sudah ada server dengan nama itu.');
  const item = db.find(x => x.id === req.params.id);
  item.name = name;
  writeDb(db);
  io.emit('servers-changed');
  res.json(publicServer(item));
}));

// Hapus server. Default: HANYA konfigurasi (folder data tetap ada).
// Menghapus data juga butuh ?deleteData=1&confirm=<id-server>.
app.delete('/api/servers/:id', requireAuth, A(async (req, res) => {
  const item = requireServer(req);
  const id = item.id;
  if (isRunning(id)) throw new FsError(409, 'Stop server sebelum menghapusnya.');
  const deleteData = bool(req.query.deleteData);
  if (deleteData && req.query.confirm !== id) throw new FsError(400, 'Konfirmasi penghapusan data tidak cocok dengan ID server.', 'CONFIRM_REQUIRED');
  if (deleteData) await fsp.rm(serverDir(id), { recursive: true, force: true });
  writeDb(readDb().filter(x => x.id !== id));
  procs.delete(id); meta.delete(id); lastExit.delete(id); logBuffers.delete(id); logSeq.delete(id);
  io.emit('servers-changed');
  res.json({ ok: true, dataDeleted: deleteData, directory: path.posix.join('servers', id) });
}));

app.post('/api/servers/:id/start', requireAuth, A((req, res) => { startProcess(requireServer(req).id); res.json({ ok: true }); }));
app.post('/api/servers/:id/stop', requireAuth, A((req, res) => { stopProcess(requireServer(req).id); res.json({ ok: true }); }));
app.post('/api/servers/:id/restart', requireAuth, A(async (req, res) => {
  const id = requireServer(req).id;
  if (isRunning(id)) {
    stopProcess(id);
    if (!(await waitExit(id, 10000))) throw new FsError(504, 'Proses belum berhenti, restart dibatalkan.');
  }
  startProcess(id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------- console */

app.get('/api/servers/:id/logs', requireAuth, A((req, res) => {
  const id = requireServer(req).id;
  const after = Number(req.query.after) || 0;
  const entries = (logBuffers.get(id) || []).filter(e => e.seq > after);
  res.json({ entries, lastSeq: logSeq.get(id) || 0, status: getStatus(id) });
}));
app.delete('/api/servers/:id/logs', requireAuth, A((req, res) => {
  const id = requireServer(req).id;
  logBuffers.set(id, []);
  io.to(`server:${id}`).emit('log-clear', { id });
  res.json({ ok: true });
}));

// Input dikirim ke stdin proses yang berjalan (bukan shell), sehingga tidak ada eksekusi perintah arbitrer.
app.post('/api/servers/:id/command', requireAuth, A((req, res) => {
  const id = requireServer(req).id;
  const child = procs.get(id);
  const command = String((req.body && req.body.command) || '').replace(/[\r\n]+/g, ' ').trim();
  if (!child || !isRunning(id)) throw new FsError(409, 'Server sedang offline. Jalankan server terlebih dahulu.');
  if (!command || command.length > 1000) throw new FsError(400, 'Perintah kosong atau lebih dari 1000 karakter.');
  if (!child.stdin.writable) throw new FsError(409, 'Input proses tidak tersedia.');
  child.stdin.write(command + '\n');
  addLog(id, 'in', command);
  res.json({ ok: true });
}));

/* ------------------------------------------------------- file manager */

function base(req) { return serverDir(requireServer(req).id); }

app.get('/api/servers/:id/files', requireAuth, A(async (req, res) => {
  res.json(await files.listDir(base(req), req.query.path || ''));
}));
app.get('/api/servers/:id/file', requireAuth, A(async (req, res) => {
  res.json(await files.readTextFile(base(req), req.query.path || ''));
}));
app.put('/api/servers/:id/file', requireAuth, A(async (req, res) => {
  const body = req.body || {};
  const r = await files.writeTextFile(base(req), body.path || '', body.content);
  res.json({ ok: true, ...r });
}));
app.post('/api/servers/:id/file', requireAuth, A(async (req, res) => {
  const body = req.body || {};
  res.json({ ok: true, ...(await files.createFile(base(req), body.dir || '', body.name, body.content)) });
}));
app.post('/api/servers/:id/folder', requireAuth, A(async (req, res) => {
  const body = req.body || {};
  res.json({ ok: true, ...(await files.createFolder(base(req), body.dir || '', body.name)) });
}));
app.post('/api/servers/:id/rename', requireAuth, A(async (req, res) => {
  const body = req.body || {};
  res.json({ ok: true, ...(await files.renameEntry(base(req), body.path || '', body.newName)) });
}));
app.post('/api/servers/:id/delete', requireAuth, A(async (req, res) => {
  const body = req.body || {};
  const results = await files.removeMany(base(req), body.dir || '', body.names);
  res.json({ ok: results.every(r => r.ok), results });
}));

// Upload streaming: body = isi file mentah (application/octet-stream).
app.put('/api/servers/:id/upload', requireAuth, A(async (req, res) => {
  const b = base(req);
  const length = Number(req.headers['content-length']);
  if (!Number.isFinite(length)) throw new FsError(411, 'Header Content-Length diperlukan untuk upload.');
  if (length > MAX_UPLOAD_BYTES) {
    res.setHeader('Connection', 'close');
    throw new FsError(413, `Ukuran file melebihi batas upload ${(MAX_UPLOAD_BYTES / 1048576).toFixed(0)} MB.`, 'TOO_LARGE');
  }
  const r = await files.uploadStream(b, req.query.path || '', req.query.name, req, { overwrite: bool(req.query.overwrite), maxBytes: MAX_UPLOAD_BYTES });
  res.json({ ok: true, ...r });
}));

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

app.get('/api/servers/:id/download', requireAuth, A(async (req, res) => {
  const b = base(req);
  const { target, stat, name, clean } = await files.statForDownload(b, req.query.path || '');
  if (stat.isDirectory()) {
    const parent = path.dirname(target);
    const { entries } = await zip.collectEntries(parent, [path.basename(target)]);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${clean ? name : 'server'}.zip`));
    res.setHeader('Cache-Control', 'no-store');
    try { await zip.writeZip(entries, res); }
    catch (e) { res.destroy(); if (!/ditutup/.test(String(e.message))) console.error('Download ZIP gagal:', e.message); }
    return;
  }
  if (!stat.isFile()) throw new FsError(400, 'Hanya file dan folder yang bisa diunduh.');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.setHeader('Cache-Control', 'no-store');
  const stream = fs.createReadStream(target);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}));

app.post('/api/servers/:id/zip', requireAuth, A(async (req, res) => {
  const b = base(req);
  const body = req.body || {};
  const names = body.names;
  if (!Array.isArray(names) || names.length === 0) throw new FsError(400, 'Pilih minimal satu file atau folder.');
  if (names.length > 5000) throw new FsError(400, 'Terlalu banyak item dipilih.');
  names.forEach(n => files.validateName(n, 'Nama item'));
  let zipName = files.validateName(String(body.zipName || ''), 'Nama ZIP');
  if (!/\.zip$/i.test(zipName)) zipName += '.zip';
  files.validateName(zipName, 'Nama ZIP');

  const dir = await files.requireDir(b, body.dir || '');
  for (const n of names) {
    const check = await files.resolveSafe(b, files.childRel(dir.clean, n), { follow: false });
    if (!(await files.exists(check.target))) throw new FsError(404, `"${n}" tidak ditemukan.`);
  }
  const finalPath = path.join(dir.target, zipName);
  const existing = await fsp.lstat(finalPath).catch(() => null);
  if (existing) {
    if (existing.isDirectory()) throw new FsError(409, `Sudah ada folder bernama "${zipName}".`, 'EXISTS_DIR');
    if (!bool(body.overwrite)) throw new FsError(409, `"${zipName}" sudah ada.`, 'EXISTS');
  }
  const { entries, skipped } = await zip.collectEntries(dir.target, names, { exclude: new Set([finalPath]) });
  const part = path.join(dir.target, `.zip-${files.rand()}.part`);
  const out = fs.createWriteStream(part, { flags: 'wx' });
  try {
    const info = await zip.writeZip(entries, out);
    await fsp.rename(part, finalPath);
    const size = (await fsp.stat(finalPath)).size;
    res.json({ ok: true, name: zipName, path: files.childRel(dir.clean, zipName), entries: info.entries, files: info.files, size, skippedLinks: skipped });
  } catch (e) {
    out.destroy();
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}));

async function zipJob(req) {
  const b = base(req);
  const body = req.body || {};
  const zipInfo = await files.resolveSafe(b, body.path || '');
  const st = await fsp.stat(zipInfo.target).catch(e => { throw files.mapFsError(e); });
  if (!st.isFile()) throw new FsError(400, 'Path ZIP bukan file.');
  const dest = await files.requireDir(b, body.dest || '');
  return { zipPath: zipInfo.target, dest };
}

app.post('/api/servers/:id/extract/check', requireAuth, A(async (req, res) => {
  const { zipPath, dest } = await zipJob(req);
  const a = await zip.analyzeZip(zipPath, dest.target, ZIP_LIMITS);
  res.json({
    ok: a.blocking.length === 0,
    dest: dest.clean,
    files: a.files, dirs: a.dirs, skipped: a.skipped, totalBytes: a.totalBytes,
    conflictCount: a.conflicts.length, conflicts: a.conflicts.slice(0, 200),
    blocking: a.blocking
  });
}));

app.post('/api/servers/:id/extract', requireAuth, A(async (req, res) => {
  const { zipPath, dest } = await zipJob(req);
  const stats = await zip.extractZip(zipPath, dest.target, { overwrite: bool((req.body || {}).overwrite), stageRoot: TMP_DIR, limits: ZIP_LIMITS });
  res.json({ ok: true, dest: dest.clean, ...stats });
}));

/* ------------------------------------------------------------- errors */

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return res.destroy();
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body JSON tidak valid.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Data terlalu besar.' });
  const e = files.mapFsError(err);
  if (e.status >= 500) console.error('Error:', err);
  const payload = { error: e.message };
  if (e.code) payload.code = e.code;
  if (e.details) Object.assign(payload, e.details);
  res.status(e.status).json(payload);
});

/* ------------------------------------------------------------ socket */

io.use((socket, next) => {
  if (socket.request.session && socket.request.session.authenticated) return next();
  next(new Error('Unauthorized'));
});
io.on('connection', socket => {
  socket.on('join-server', id => {
    if (!safeId(id) || !getServer(id)) return;
    socket.join(`server:${id}`);
    socket.emit('log-history', { id, entries: logBuffers.get(id) || [], lastSeq: logSeq.get(id) || 0, status: getStatus(id) });
  });
  socket.on('leave-server', id => { if (safeId(id)) socket.leave(`server:${id}`); });
});

/* ---------------------------------------------------------- lifecycle */

server.listen(PORT, HOST, () => {
  console.log(`Panel berjalan di http://${HOST}:${PORT}`);
  console.log('Folder project:', SERVERS_DIR);
});

function shutdown() {
  for (const child of procs.values()) killTree(child, 'SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
