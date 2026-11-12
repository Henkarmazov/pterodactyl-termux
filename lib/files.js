'use strict';

/**
 * Operasi file yang dibatasi pada satu direktori root server.
 * Semua fungsi menerima `base` (path absolut folder server) dan path relatif
 * dari klien. Path relatif divalidasi secara leksikal (tanpa "..") dan lewat
 * realpath (menolak symlink yang keluar dari root).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

class FsError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'FsError';
    this.status = status;
    this.code = code || null;
    this.details = details || null;
    this.expose = true;
  }
}

const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_NAME_BYTES = 255;

function rand(bytes = 6) { return crypto.randomBytes(bytes).toString('hex'); }

function mapFsError(err) {
  if (err instanceof FsError) return err;
  if (err && err.expose && typeof err.status === 'number') return err;
  const map = {
    ENOENT: [404, 'File atau folder tidak ditemukan.'],
    EEXIST: [409, 'File atau folder dengan nama itu sudah ada.'],
    ENOTDIR: [400, 'Salah satu bagian path bukan folder.'],
    EISDIR: [400, 'Target adalah folder, bukan file.'],
    EACCES: [403, 'Akses ditolak oleh sistem operasi.'],
    EPERM: [403, 'Operasi tidak diizinkan oleh sistem operasi.'],
    ENOSPC: [507, 'Penyimpanan penuh.'],
    ENAMETOOLONG: [400, 'Nama atau path terlalu panjang.'],
    ENOTEMPTY: [409, 'Folder tidak kosong.'],
    EBUSY: [409, 'File sedang digunakan.']
  };
  const hit = err && map[err.code];
  if (hit) return new FsError(hit[0], hit[1], err.code);
  return new FsError(500, 'Terjadi kesalahan pada server.', 'INTERNAL');
}

function validateName(name, label = 'Nama') {
  if (typeof name !== 'string' || name.length === 0) throw new FsError(400, `${label} tidak boleh kosong.`);
  if (name !== name.trim()) throw new FsError(400, `${label} tidak boleh diawali atau diakhiri spasi.`);
  if (name === '.' || name === '..') throw new FsError(400, `${label} tidak valid.`);
  if (/[\/\\\u0000-\u001f\u007f]/.test(name)) throw new FsError(400, `${label} tidak boleh mengandung "/", "\\" atau karakter kontrol.`);
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) throw new FsError(400, `${label} terlalu panjang (maksimal ${MAX_NAME_BYTES} byte).`);
  return name;
}

// Normalisasi path relatif: pemisah "/", tanpa ".", tanpa "..", tanpa path absolut.
function normalizeRel(rel) {
  const value = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (value.includes('\0')) throw new FsError(400, 'Path tidak valid.');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) throw new FsError(400, 'Path absolut tidak diizinkan.');
  const segs = [];
  for (const seg of value.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new FsError(403, 'Path di luar folder server ditolak.');
    segs.push(seg);
  }
  return segs.join('/');
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

/**
 * Mengembalikan path absolut yang aman untuk `rel` di dalam `base`.
 * follow=true  : target akhir (jika ada) harus berada di dalam root setelah symlink diselesaikan.
 * follow=false : hanya parent yang dicek (untuk operasi pada symlink itu sendiri, mis. hapus/rename).
 */
async function resolveSafe(base, rel, { follow = true } = {}) {
  const clean = normalizeRel(rel);
  const baseReal = await fsp.realpath(base);
  const target = clean ? path.join(base, ...clean.split('/')) : base;
  const doFollow = follow || clean === '';

  let probe = doFollow ? target : path.dirname(target);
  for (;;) {
    let st = null;
    try { st = await fsp.lstat(probe); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
    if (st) {
      let real;
      try { real = await fsp.realpath(probe); } catch (e) {
        if (st.isSymbolicLink()) throw new FsError(403, 'Symlink rusak atau mengarah ke luar folder server ditolak.');
        throw e;
      }
      if (!isInside(baseReal, real)) throw new FsError(403, 'Path di luar folder server ditolak.');
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) throw new FsError(403, 'Path di luar folder server ditolak.');
    probe = parent;
  }
  return { clean, target, baseReal };
}

function childRel(dirClean, name) {
  return dirClean ? `${dirClean}/${name}` : name;
}

async function listDir(base, rel) {
  const { clean, target } = await resolveSafe(base, rel);
  let st;
  try { st = await fsp.stat(target); } catch (e) { throw mapFsError(e); }
  if (!st.isDirectory()) throw new FsError(400, 'Path bukan folder.');
  const names = await fsp.readdir(target);
  const items = [];
  for (let i = 0; i < names.length; i += 64) {
    const part = await Promise.all(names.slice(i, i + 64).map(async name => {
      const full = path.join(target, name);
      try {
        const l = await fsp.lstat(full);
        if (l.isSymbolicLink()) {
          try {
            const s = await fsp.stat(full);
            return { name, type: s.isDirectory() ? 'directory' : 'file', size: s.isFile() ? s.size : 0, mtime: s.mtimeMs, link: true };
          } catch {
            return { name, type: 'file', size: 0, mtime: l.mtimeMs, link: true, broken: true };
          }
        }
        return { name, type: l.isDirectory() ? 'directory' : 'file', size: l.isFile() ? l.size : 0, mtime: l.mtimeMs };
      } catch { return null; }
    }));
    for (const item of part) if (item) items.push(item);
  }
  items.sort((a, b) => (a.type === b.type
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : a.type === 'directory' ? -1 : 1));
  return { path: clean, items };
}

async function readTextFile(base, rel) {
  const { clean, target } = await resolveSafe(base, rel);
  let st;
  try { st = await fsp.stat(target); } catch (e) { throw mapFsError(e); }
  if (!st.isFile()) throw new FsError(400, 'Path bukan file.');
  if (st.size > MAX_EDIT_BYTES) throw new FsError(413, 'File terlalu besar untuk editor (maksimal 1 MB). Gunakan Download.', 'TOO_LARGE');
  const buf = await fsp.readFile(target);
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) throw new FsError(415, 'File biner tidak bisa diedit sebagai teks. Gunakan Download.', 'BINARY');
  const content = buf.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(buf)) {
    throw new FsError(415, 'File bukan teks UTF-8 yang valid, sehingga tidak aman diedit. Gunakan Download.', 'NOT_UTF8');
  }
  return { path: clean, content, size: st.size, mtime: st.mtimeMs };
}

async function writeTextFile(base, rel, content) {
  const text = String(content == null ? '' : content);
  if (Buffer.byteLength(text, 'utf8') > MAX_EDIT_BYTES) throw new FsError(413, 'File terlalu besar (maksimal 1 MB).', 'TOO_LARGE');
  const { clean, target } = await resolveSafe(base, rel);
  let st;
  try { st = await fsp.stat(target); } catch (e) { throw mapFsError(e); }
  if (!st.isFile()) throw new FsError(400, 'Path bukan file.');
  await fsp.writeFile(target, text, 'utf8');
  const after = await fsp.stat(target);
  return { path: clean, size: after.size, mtime: after.mtimeMs };
}

async function requireDir(base, dirRel) {
  const dir = await resolveSafe(base, dirRel);
  let st;
  try { st = await fsp.stat(dir.target); } catch (e) { throw mapFsError(e); }
  if (!st.isDirectory()) throw new FsError(400, 'Folder tujuan bukan folder.');
  return dir;
}

async function createFile(base, dirRel, name, content = '') {
  validateName(name, 'Nama file');
  const text = String(content || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_EDIT_BYTES) throw new FsError(413, 'Isi awal terlalu besar.');
  const dir = await requireDir(base, dirRel);
  const full = path.join(dir.target, name);
  try { await fsp.writeFile(full, text, { encoding: 'utf8', flag: 'wx' }); } catch (e) { throw mapFsError(e); }
  return { path: childRel(dir.clean, name) };
}

async function createFolder(base, dirRel, name) {
  validateName(name, 'Nama folder');
  const dir = await requireDir(base, dirRel);
  try { await fsp.mkdir(path.join(dir.target, name)); } catch (e) { throw mapFsError(e); }
  return { path: childRel(dir.clean, name) };
}

async function renameEntry(base, rel, newName) {
  const from = await resolveSafe(base, rel, { follow: false });
  if (!from.clean) throw new FsError(400, 'Folder root server tidak bisa di-rename.');
  validateName(newName, 'Nama baru');
  const oldName = from.clean.split('/').pop();
  if (newName === oldName) throw new FsError(400, 'Nama baru sama dengan nama lama.');
  if (!(await exists(from.target))) throw new FsError(404, 'File atau folder tidak ditemukan.');
  const to = path.join(path.dirname(from.target), newName);
  const caseOnly = newName.toLowerCase() === oldName.toLowerCase();
  if (!caseOnly && (await exists(to))) throw new FsError(409, `"${newName}" sudah ada di folder ini.`, 'EXISTS');
  try { await fsp.rename(from.target, to); } catch (e) { throw mapFsError(e); }
  const parent = from.clean.split('/').slice(0, -1).join('/');
  return { path: childRel(parent, newName) };
}

async function removeEntry(base, rel) {
  const target = await resolveSafe(base, rel, { follow: false });
  if (!target.clean) throw new FsError(400, 'Folder root server tidak bisa dihapus dari file manager.');
  if (!(await exists(target.target))) throw new FsError(404, 'File atau folder tidak ditemukan.');
  try { await fsp.rm(target.target, { recursive: true, force: false }); } catch (e) { throw mapFsError(e); }
}

async function removeMany(base, dirRel, names) {
  if (!Array.isArray(names) || names.length === 0) throw new FsError(400, 'Tidak ada item yang dipilih.');
  if (names.length > 5000) throw new FsError(400, 'Terlalu banyak item dalam satu operasi.');
  const dir = await requireDir(base, dirRel);
  const results = [];
  for (const name of names) {
    try {
      validateName(name, 'Nama item');
      await removeEntry(base, childRel(dir.clean, name));
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name: String(name), ok: false, error: mapFsError(e).message });
    }
  }
  return results;
}

/**
 * Upload streaming ke file sementara lalu rename (atomik), sehingga upload yang
 * terputus tidak meninggalkan file setengah jadi atau merusak file lama.
 */
async function uploadStream(base, dirRel, name, input, { overwrite = false, maxBytes = Infinity } = {}) {
  validateName(name, 'Nama file');
  const dir = await requireDir(base, dirRel);
  const finalPath = path.join(dir.target, name);
  let existing = null;
  try { existing = await fsp.lstat(finalPath); } catch {}
  if (existing) {
    if (existing.isDirectory()) throw new FsError(409, `Sudah ada folder bernama "${name}".`, 'EXISTS_DIR');
    if (!overwrite) throw new FsError(409, `"${name}" sudah ada.`, 'EXISTS');
  }
  const part = path.join(dir.target, `.upload-${rand()}.part`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new FsError(413, 'Ukuran upload melebihi batas yang diizinkan.', 'TOO_LARGE'));
      cb(null, chunk);
    }
  });
  try {
    await pipeline(input, limiter, fs.createWriteStream(part, { flags: 'wx', mode: 0o644 }));
    await fsp.rename(part, finalPath);
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw mapFsError(e);
  }
  return { path: childRel(dir.clean, name), name, size, overwritten: Boolean(existing) };
}

async function statForDownload(base, rel) {
  const { clean, target } = await resolveSafe(base, rel);
  let st;
  try { st = await fsp.stat(target); } catch (e) { throw mapFsError(e); }
  return { clean, target, stat: st, name: clean ? clean.split('/').pop() : 'server' };
}

module.exports = {
  FsError, MAX_EDIT_BYTES, mapFsError, validateName, normalizeRel, resolveSafe, isInside, exists, rand,
  childRel, listDir, readTextFile, writeTextFile, createFile, createFolder, renameEntry,
  removeEntry, removeMany, requireDir, uploadStream, statForDownload
};
