'use strict';

/**
 * Pembuat dan pengekstrak ZIP murni Node.js (hanya zlib/fs bawaan).
 *
 * Pembuatan : streaming (data descriptor), bisa ke file maupun ke HTTP response.
 * Ekstraksi : dua tahap (analisis -> staging -> merge) supaya arsip yang rusak atau
 *             berbahaya tidak meninggalkan setengah hasil di folder tujuan.
 *
 * Perlindungan: ZIP Slip (".." / path absolut / drive letter), symlink dalam arsip
 * (dilewati), symlink pada jalur tujuan (ditolak), zip bomb (batas ukuran deklarasi dan
 * ukuran aktual), jumlah entri, entri terenkripsi (ditolak), CRC32 diverifikasi.
 * Batasan: ZIP64 (>4 GB atau >65535 entri) tidak didukung.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { Transform, pipeline: pipelineCb } = require('stream');
const { pipeline } = require('stream/promises');
const { FsError, rand, isInside } = require('./files');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESC = 0x08074b50;
const MAX_U32 = 0xFFFFFFFF;
const MAX_ENTRIES_WRITE = 0xFFFF;

const DEFAULT_LIMITS = {
  maxEntries: 20000,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxCentralDirBytes: 64 * 1024 * 1024
};

/* ---------------------------------------------------------------- CRC32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Js(buf, prev = 0) {
  let c = (prev ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// zlib.crc32 tersedia di Node >= 20.15 / 22.2; fallback JS untuk versi lain.
const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0 : crc32Js;

/* ----------------------------------------------------------- DOS time */

function toDos(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: day & 0xFFFF };
}

function fromDos(dosDate, dosTime) {
  const year = ((dosDate >> 9) & 0x7F) + 1980;
  const month = ((dosDate >> 5) & 0x0F) || 1;
  const day = (dosDate & 0x1F) || 1;
  const hour = (dosTime >> 11) & 0x1F;
  const min = (dosTime >> 5) & 0x3F;
  const sec = (dosTime & 0x1F) * 2;
  const d = new Date(year, month - 1, day, hour, min, sec);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------- Writer */

function waitDrain(out) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { out.off('drain', onDrain); out.off('close', onClose); out.off('error', onError); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Koneksi output ditutup sebelum selesai.')); };
    const onError = e => { cleanup(); reject(e); };
    out.on('drain', onDrain); out.on('close', onClose); out.on('error', onError);
  });
}

class Sink {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.error = null;
    out.on('error', e => { this.error = e; });
  }
  async write(buf) {
    if (this.error) throw this.error;
    if (this.out.destroyed) throw new Error('Koneksi output ditutup sebelum selesai.');
    this.offset += buf.length;
    if (this.offset > MAX_U32) throw new FsError(413, 'Hasil ZIP melebihi 4 GB (ZIP64 tidak didukung).', 'ZIP_TOO_BIG');
    if (!this.out.write(buf)) await waitDrain(this.out);
  }
}

/**
 * Mengumpulkan entri untuk dikompres. `names` adalah nama anak langsung dari `baseDir`.
 * Symlink dilewati (tidak diikuti) agar tidak membocorkan file di luar root.
 */
async function collectEntries(baseDir, names, { exclude = new Set() } = {}) {
  const entries = [];
  let skipped = 0;
  async function walk(abs, name) {
    if (exclude.has(abs)) return;
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) { skipped++; return; }
    if (st.isDirectory()) {
      entries.push({ abs, name: `${name}/`, isDir: true, mtime: st.mtime, mode: st.mode });
      if (entries.length > MAX_ENTRIES_WRITE) throw new FsError(413, 'Terlalu banyak item untuk satu ZIP (maksimal 65535).', 'ZIP_TOO_MANY');
      const children = (await fsp.readdir(abs)).sort();
      for (const child of children) await walk(path.join(abs, child), `${name}/${child}`);
    } else if (st.isFile()) {
      entries.push({ abs, name, isDir: false, mtime: st.mtime, mode: st.mode, size: st.size });
      if (entries.length > MAX_ENTRIES_WRITE) throw new FsError(413, 'Terlalu banyak item untuk satu ZIP (maksimal 65535).', 'ZIP_TOO_MANY');
    } else {
      skipped++;
    }
  }
  for (const n of names) await walk(path.join(baseDir, n), n);
  return { entries, skipped };
}

/**
 * Menulis ZIP ke stream `out` (file atau HTTP response) lalu menutupnya.
 */
async function writeZip(entries, out) {
  if (entries.length > MAX_ENTRIES_WRITE) throw new FsError(413, 'Terlalu banyak item untuk satu ZIP (maksimal 65535).', 'ZIP_TOO_MANY');
  const sink = new Sink(out);
  const central = [];
  let fileCount = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    if (nameBuf.length > 0xFFFF) throw new FsError(400, 'Nama entri terlalu panjang.');
    const { time, date } = toDos(e.mtime);
    const isDir = e.isDir;
    const flags = 0x0800 | (isDir ? 0 : 0x0008);
    const method = isDir ? 0 : 8;
    const offset = sink.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    await sink.write(header);
    await sink.write(nameBuf);

    let crc = 0; let usize = 0; let csize = 0;
    if (!isDir) {
      const counter = new Transform({
        transform(chunk, _enc, cb) { crc = crc32(chunk, crc); usize += chunk.length; cb(null, chunk); }
      });
      const deflate = zlib.createDeflateRaw({ level: 6 });
      const source = fs.createReadStream(e.abs);
      // pipeline() menghancurkan semua stream jika salah satunya error; iterator di bawah ikut melempar.
      pipelineCb(source, counter, deflate, () => {});
      for await (const chunk of deflate) {
        csize += chunk.length;
        await sink.write(chunk);
      }
      if (usize > MAX_U32 || csize > MAX_U32) throw new FsError(413, `File "${e.name}" terlalu besar untuk ZIP (maksimal 4 GB).`, 'ZIP_TOO_BIG');
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(SIG_DESC, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
      await sink.write(desc);
      fileCount++;
    }

    const perm = (e.mode & 0o777) || (isDir ? 0o755 : 0o644);
    const unixMode = ((isDir ? 0o040000 : 0o100000) | perm) >>> 0;
    const externalAttr = (((unixMode << 16) >>> 0) | (isDir ? 0x10 : 0)) >>> 0;
    central.push({ nameBuf, flags, method, time, date, crc: crc >>> 0, csize, usize, offset, externalAttr });
  }

  const cdStart = sink.offset;
  for (const c of central) {
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(SIG_CENTRAL, 0);
    rec.writeUInt16LE((3 << 8) | 20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(c.flags, 8);
    rec.writeUInt16LE(c.method, 10);
    rec.writeUInt16LE(c.time, 12);
    rec.writeUInt16LE(c.date, 14);
    rec.writeUInt32LE(c.crc, 16);
    rec.writeUInt32LE(c.csize, 20);
    rec.writeUInt32LE(c.usize, 24);
    rec.writeUInt16LE(c.nameBuf.length, 28);
    rec.writeUInt16LE(0, 30);
    rec.writeUInt16LE(0, 32);
    rec.writeUInt16LE(0, 34);
    rec.writeUInt16LE(0, 36);
    rec.writeUInt32LE(c.externalAttr, 38);
    rec.writeUInt32LE(c.offset, 42);
    await sink.write(rec);
    await sink.write(c.nameBuf);
  }
  const cdSize = sink.offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  await sink.write(eocd);

  await new Promise((resolve, reject) => {
    if (out instanceof fs.WriteStream) { out.once('error', reject); out.once('close', resolve); out.end(); }
    else { out.end(resolve); }
  });
  return { entries: central.length, files: fileCount, bytes: sink.offset };
}

/* ------------------------------------------------------------- Reader */

async function readZipEntries(zipPath, limits = DEFAULT_LIMITS) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new FsError(400, 'File ZIP tidak valid atau kosong.', 'BAD_ZIP');
    const tailLen = Math.min(size, 22 + 0xFFFF);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) <= tailLen) { eocd = i; break; }
    }
    if (eocd < 0) throw new FsError(400, 'File ini bukan ZIP yang valid (end-of-central-directory tidak ditemukan).', 'BAD_ZIP');

    const diskNo = tail.readUInt16LE(eocd + 4);
    const cdDisk = tail.readUInt16LE(eocd + 6);
    const onDisk = tail.readUInt16LE(eocd + 8);
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (diskNo !== 0 || cdDisk !== 0 || onDisk !== total) throw new FsError(415, 'ZIP multi-bagian tidak didukung.', 'ZIP_UNSUPPORTED');
    if (total === 0xFFFF || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new FsError(415, 'ZIP64 tidak didukung.', 'ZIP_UNSUPPORTED');
    if (total > limits.maxEntries) throw new FsError(413, `ZIP berisi terlalu banyak entri (${total}; batas ${limits.maxEntries}).`, 'ZIP_TOO_MANY');
    if (cdOffset + cdSize > size || cdSize > limits.maxCentralDirBytes) throw new FsError(400, 'Struktur ZIP rusak.', 'BAD_ZIP');

    const cd = Buffer.alloc(cdSize);
    if (cdSize) await fh.read(cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cdSize || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new FsError(400, 'Struktur ZIP rusak (central directory).', 'BAD_ZIP');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen + extraLen + commentLen > cdSize) throw new FsError(400, 'Struktur ZIP rusak (central directory).', 'BAD_ZIP');
      const flags = cd.readUInt16LE(p + 8);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      let name = nameBuf.toString('utf8');
      if (!(flags & 0x0800) && name.includes('\uFFFD')) name = nameBuf.toString('latin1');
      const entry = {
        name,
        flags,
        versionMadeBy: cd.readUInt16LE(p + 4),
        method: cd.readUInt16LE(p + 10),
        dosTime: cd.readUInt16LE(p + 12),
        dosDate: cd.readUInt16LE(p + 14),
        crc: cd.readUInt32LE(p + 16),
        csize: cd.readUInt32LE(p + 20),
        usize: cd.readUInt32LE(p + 24),
        externalAttr: cd.readUInt32LE(p + 38),
        offset: cd.readUInt32LE(p + 42)
      };
      if (entry.csize === MAX_U32 || entry.usize === MAX_U32 || entry.offset === MAX_U32) {
        throw new FsError(415, 'ZIP64 tidak didukung.', 'ZIP_UNSUPPORTED');
      }
      entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { size, entries };
  } finally {
    await fh.close();
  }
}

// Mengembalikan segmen path aman dari nama entri ZIP, atau melempar error jika berbahaya.
function safeSegments(rawName) {
  const unsafe = () => new FsError(400, `Arsip ditolak: entri berbahaya "${String(rawName).slice(0, 80)}".`, 'ZIP_UNSAFE');
  const name = String(rawName).replace(/\\/g, '/');
  if (name.includes('\0')) throw unsafe();
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw unsafe();
  const segs = [];
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw unsafe();
    if (/[\u0000-\u001f\u007f]/.test(seg)) throw unsafe();
    if (Buffer.byteLength(seg, 'utf8') > 255) throw new FsError(400, `Arsip ditolak: nama terlalu panjang "${seg.slice(0, 40)}...".`, 'ZIP_UNSAFE');
    segs.push(seg);
  }
  return segs;
}

/**
 * Menganalisis arsip terhadap folder tujuan tanpa menulis apa pun.
 * Mengembalikan ringkasan, daftar konflik (file yang akan ditimpa), dan masalah yang memblokir.
 */
async function analyzeZip(zipPath, destAbs, limits = DEFAULT_LIMITS) {
  const { size, entries: raw } = await readZipEntries(zipPath, limits);
  const entries = [];
  let totalBytes = 0; let files = 0; let dirs = 0; let skipped = 0;

  for (const e of raw) {
    if (e.flags & 0x0001) throw new FsError(415, 'ZIP terenkripsi (password) tidak didukung.', 'ZIP_UNSUPPORTED');
    const segs = safeSegments(e.name);
    if (segs.length === 0) continue;
    const unixMode = (e.versionMadeBy >> 8) === 3 ? (e.externalAttr >>> 16) : 0;
    const fmt = unixMode & 0o170000;
    if (fmt === 0o120000) { skipped++; continue; }
    if (unixMode && fmt !== 0 && fmt !== 0o100000 && fmt !== 0o040000) { skipped++; continue; }
    const isDir = e.name.endsWith('/') || e.name.endsWith('\\') || fmt === 0o040000 || Boolean(e.externalAttr & 0x10);
    if (!isDir) {
      if (e.method !== 0 && e.method !== 8) throw new FsError(415, `Metode kompresi ${e.method} pada "${segs.join('/')}" tidak didukung.`, 'ZIP_UNSUPPORTED');
      if (e.method === 0 && e.csize !== e.usize) throw new FsError(400, `Struktur ZIP rusak pada "${segs.join('/')}".`, 'BAD_ZIP');
      totalBytes += e.usize;
      if (totalBytes > limits.maxTotalBytes) {
        throw new FsError(413, `Ukuran hasil ekstraksi melebihi batas ${(limits.maxTotalBytes / 1048576).toFixed(0)} MB.`, 'ZIP_TOO_BIG');
      }
      files++;
    } else { dirs++; }
    entries.push({ ...e, segs, isDir, unixMode, mtime: fromDos(e.dosDate, e.dosTime) });
  }

  const conflicts = []; const blocking = [];
  const cache = new Map();
  async function stat(p) {
    if (cache.has(p)) return cache.get(p);
    let st = null;
    try { st = await fsp.lstat(p); } catch {}
    cache.set(p, st);
    return st;
  }
  for (const e of entries) {
    let cur = destAbs;
    for (let k = 0; k < e.segs.length; k++) {
      cur = path.join(cur, e.segs[k]);
      const st = await stat(cur);
      if (!st) break;
      const last = k === e.segs.length - 1;
      const rel = e.segs.slice(0, k + 1).join('/');
      if (st.isSymbolicLink()) { blocking.push(`"${rel}" di folder tujuan adalah symlink, ekstraksi ditolak.`); break; }
      if (!last) {
        if (!st.isDirectory()) { blocking.push(`"${rel}" adalah file di folder tujuan, tetapi ZIP membutuhkan folder.`); break; }
        continue;
      }
      if (e.isDir) {
        if (!st.isDirectory()) blocking.push(`"${rel}" adalah file di folder tujuan, tetapi ZIP membutuhkan folder.`);
      } else if (st.isDirectory()) {
        blocking.push(`"${rel}" adalah folder di folder tujuan, tetapi ZIP membutuhkan file.`);
      } else if (!conflicts.includes(rel)) {
        conflicts.push(rel);
      }
    }
  }
  return {
    size, entries, files, dirs, skipped, totalBytes,
    conflicts, blocking: [...new Set(blocking)]
  };
}

async function moveFile(src, dst) {
  try { await fsp.rename(src, dst); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

async function extractEntryToFile(zipPath, zipSize, fh, entry, outFile, state) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const perm = (((entry.unixMode & 0o777) || 0o644) | 0o600) & 0o755;

  if (entry.usize === 0) {
    await fsp.writeFile(outFile, '', { flag: 'wx', mode: perm });
  } else {
    const lh = Buffer.alloc(30);
    const { bytesRead } = await fh.read(lh, 0, 30, entry.offset);
    if (bytesRead < 30 || lh.readUInt32LE(0) !== SIG_LOCAL) throw new FsError(400, `Struktur ZIP rusak pada "${entry.segs.join('/')}".`, 'BAD_ZIP');
    const dataStart = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (entry.csize === 0 || dataStart + entry.csize > zipSize) throw new FsError(400, `Struktur ZIP rusak pada "${entry.segs.join('/')}".`, 'BAD_ZIP');

    let written = 0; let crc = 0;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > entry.usize) return cb(new FsError(400, `Data "${entry.segs.join('/')}" melebihi ukuran deklarasi (kemungkinan zip bomb).`, 'ZIP_BOMB'));
        crc = crc32(chunk, crc);
        cb(null, chunk);
      }
    });
    const stages = [fs.createReadStream(zipPath, { start: dataStart, end: dataStart + entry.csize - 1 })];
    if (entry.method === 8) stages.push(zlib.createInflateRaw());
    stages.push(guard, fs.createWriteStream(outFile, { flags: 'wx', mode: perm }));
    await pipeline(...stages);
    if (written !== entry.usize) throw new FsError(400, `Ukuran data "${entry.segs.join('/')}" tidak cocok. Arsip rusak.`, 'BAD_ZIP');
    if ((crc >>> 0) !== entry.crc) throw new FsError(400, `CRC "${entry.segs.join('/')}" tidak cocok. Arsip rusak.`, 'BAD_ZIP');
  }
  if (entry.mtime) { try { await fsp.utimes(outFile, entry.mtime, entry.mtime); } catch {} }
  state.bytes += entry.usize;
}

async function mergeDir(srcDir, dstDir, stats) {
  await fsp.mkdir(dstDir, { recursive: true });
  for (const dirent of await fsp.readdir(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, dirent.name);
    const d = path.join(dstDir, dirent.name);
    let existing = null;
    try { existing = await fsp.lstat(d); } catch {}
    if (dirent.isDirectory()) {
      if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new FsError(409, `Konflik saat menggabungkan folder "${dirent.name}".`, 'ZIP_BLOCKED');
      await mergeDir(s, d, stats);
    } else {
      if (existing && existing.isDirectory()) throw new FsError(409, `Konflik: "${dirent.name}" adalah folder di tujuan.`, 'ZIP_BLOCKED');
      if (existing) stats.overwritten++;
      await moveFile(s, d);
      stats.files++;
    }
  }
}

/**
 * Mengekstrak `zipPath` ke `destAbs`. `stageRoot` harus berada pada filesystem yang sama.
 * Jika ada file yang akan tertimpa dan overwrite=false, melempar error CONFLICT.
 */
async function extractZip(zipPath, destAbs, { overwrite = false, stageRoot, limits = DEFAULT_LIMITS } = {}) {
  const analysis = await analyzeZip(zipPath, destAbs, limits);
  if (analysis.blocking.length) {
    throw new FsError(409, analysis.blocking[0], 'ZIP_BLOCKED', { blocking: analysis.blocking });
  }
  if (analysis.conflicts.length && !overwrite) {
    throw new FsError(409, `${analysis.conflicts.length} file akan tertimpa. Konfirmasi diperlukan.`, 'CONFLICT', { conflicts: analysis.conflicts.slice(0, 200), conflictCount: analysis.conflicts.length });
  }

  await fsp.mkdir(stageRoot, { recursive: true });
  const stage = path.join(stageRoot, `extract-${rand()}`);
  await fsp.mkdir(stage);
  const stats = { files: 0, dirs: analysis.dirs, bytes: 0, overwritten: 0, skipped: analysis.skipped };
  const state = { bytes: 0 };
  const fh = await fsp.open(zipPath, 'r');
  try {
    for (const entry of analysis.entries) {
      const out = path.join(stage, ...entry.segs);
      if (!isInside(stage, out)) throw new FsError(400, 'Arsip ditolak: path keluar dari folder tujuan.', 'ZIP_UNSAFE');
      if (entry.isDir) {
        try { await fsp.mkdir(out, { recursive: true }); }
        catch (e) { throw new FsError(400, `Struktur arsip bertabrakan pada "${entry.segs.join('/')}".`, 'BAD_ZIP'); }
      } else {
        try { await extractEntryToFile(zipPath, analysis.size, fh, entry, out, state); }
        catch (e) {
          if (e && (e.code === 'EEXIST' || e.code === 'ENOTDIR' || e.code === 'EISDIR')) {
            throw new FsError(400, `Struktur arsip bertabrakan pada "${entry.segs.join('/')}".`, 'BAD_ZIP');
          }
          throw e;
        }
      }
    }
    await mergeDir(stage, destAbs, stats);
    stats.bytes = state.bytes;
    return stats;
  } finally {
    await fh.close().catch(() => {});
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  DEFAULT_LIMITS, crc32, crc32Js, collectEntries, writeZip, readZipEntries, analyzeZip, extractZip, safeSegments
};
