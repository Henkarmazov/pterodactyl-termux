'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { Readable } = require('stream');

const F = require('../lib/files');
const Z = require('../lib/zip');

async function tmp() { return fsp.mkdtemp(path.join(os.tmpdir(), 'panel-test-')); }
const hasCmd = c => spawnSync('which', [c]).status === 0;
const hasPython = hasCmd('python3');
const hasUnzip = hasCmd('unzip');
const hasZip = hasCmd('zip');

async function rejects(promise, status, code) {
  await assert.rejects(promise, e => {
    assert.equal(e.status, status, `status ${e.status} (${e.message})`);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

function py(script, ...args) {
  return execFileSync('python3', ['-c', script, ...args], { encoding: 'utf8' });
}

/* ------------------------------------------------------------ files.js */

test('normalizeRel menolak traversal dan path absolut', () => {
  assert.equal(F.normalizeRel('a//b/./c'), 'a/b/c');
  assert.equal(F.normalizeRel(''), '');
  assert.equal(F.normalizeRel('a\\b'), 'a/b');
  for (const bad of ['../x', 'a/../../x', 'a/..', '/etc/passwd', 'C:\\x', 'a\0b']) {
    assert.throws(() => F.normalizeRel(bad), e => e.status === 403 || e.status === 400, bad);
  }
});

test('validateName', () => {
  assert.equal(F.validateName('index.js'), 'index.js');
  assert.equal(F.validateName('.env'), '.env');
  for (const bad of ['', ' a', 'a ', '.', '..', 'a/b', 'a\\b', 'a\nb', 'x'.repeat(300), null, 5]) {
    assert.throws(() => F.validateName(bad), e => e.status === 400, String(bad));
  }
});

test('resolveSafe menolak symlink keluar root dan symlink rusak', async () => {
  const root = await tmp();
  const base = path.join(root, 'srv'); const outside = path.join(root, 'outside');
  await fsp.mkdir(base); await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'rahasia');
  await fsp.symlink(outside, path.join(base, 'link'));
  await fsp.symlink(path.join(outside, 'secret.txt'), path.join(base, 'file-link'));
  await fsp.symlink(path.join(outside, 'nope'), path.join(base, 'dangling'));
  await rejects(F.resolveSafe(base, 'link/secret.txt'), 403);
  await rejects(F.resolveSafe(base, 'link'), 403);
  await rejects(F.resolveSafe(base, 'file-link'), 403);
  await rejects(F.resolveSafe(base, 'dangling'), 403);
  await rejects(F.readTextFile(base, 'link/secret.txt'), 403);
  await rejects(F.writeTextFile(base, 'file-link', 'x'), 403);
  await rejects(F.createFile(base, 'link', 'x.txt'), 403);
  // operasi pada symlink itu sendiri (hapus) diizinkan dan tidak menyentuh target
  await F.removeEntry(base, 'link');
  assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true);
  assert.equal(fs.existsSync(path.join(base, 'link')), false);
});

test('CRUD file dan folder', async () => {
  const base = await tmp();
  await F.createFile(base, '', 'a.txt', 'halo');
  await rejects(F.createFile(base, '', 'a.txt'), 409);
  await F.createFolder(base, '', 'src');
  await rejects(F.createFolder(base, '', 'src'), 409);
  await F.createFile(base, 'src', 'index.js', 'console.log(1)');
  const list = await F.listDir(base, '');
  assert.deepEqual(list.items.map(i => `${i.type}:${i.name}`), ['directory:src', 'file:a.txt']);
  assert.equal(list.items[1].size, 4);
  assert.ok(list.items[1].mtime > 0);
  assert.equal((await F.readTextFile(base, 'src/index.js')).content, 'console.log(1)');
  await F.writeTextFile(base, 'src/index.js', 'console.log(2)\n');
  assert.equal(fs.readFileSync(path.join(base, 'src/index.js'), 'utf8'), 'console.log(2)\n');
  await rejects(F.writeTextFile(base, 'tidak-ada.txt', 'x'), 404);
  await rejects(F.writeTextFile(base, 'src', 'x'), 400);
  await rejects(F.readTextFile(base, '../etc/passwd'), 403);

  const r = await F.renameEntry(base, 'src', 'lib');
  assert.equal(r.path, 'lib');
  assert.ok(fs.existsSync(path.join(base, 'lib/index.js')));
  await rejects(F.renameEntry(base, 'lib', 'a.txt'), 409);
  await rejects(F.renameEntry(base, 'lib', 'x/y'), 400);
  await rejects(F.renameEntry(base, '', 'zzz'), 400);
  await rejects(F.renameEntry(base, 'tidak-ada', 'zzz'), 404);

  await rejects(F.removeEntry(base, ''), 400);
  await F.removeEntry(base, 'lib');
  assert.equal(fs.existsSync(path.join(base, 'lib')), false);
  const res = await F.removeMany(base, '', ['a.txt', 'tidak-ada', '../x']);
  assert.deepEqual(res.map(x => x.ok), [true, false, false]);
});

test('readTextFile menolak biner, non-UTF8, dan file besar', async () => {
  const base = await tmp();
  await fsp.writeFile(path.join(base, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  await fsp.writeFile(path.join(base, 'latin.txt'), Buffer.from([0x68, 0xe9, 0x6c]));
  await fsp.writeFile(path.join(base, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 97));
  await rejects(F.readTextFile(base, 'bin.dat'), 415, 'BINARY');
  await rejects(F.readTextFile(base, 'latin.txt'), 415, 'NOT_UTF8');
  await rejects(F.readTextFile(base, 'big.txt'), 413);
  await rejects(F.writeTextFile(base, 'bin.dat', 'x'.repeat(1024 * 1024 + 1)), 413);
});

test('uploadStream: sukses, konflik, overwrite, batas ukuran, tanpa sisa .part', async () => {
  const base = await tmp();
  const data = crypto.randomBytes(300000);
  const r = await F.uploadStream(base, '', 'data.bin', Readable.from([data]), { maxBytes: 1e6 });
  assert.equal(r.size, data.length);
  assert.ok(fs.readFileSync(path.join(base, 'data.bin')).equals(data));
  await rejects(F.uploadStream(base, '', 'data.bin', Readable.from([Buffer.from('x')])), 409, 'EXISTS');
  assert.ok(fs.readFileSync(path.join(base, 'data.bin')).equals(data), 'file lama tidak berubah');
  const r2 = await F.uploadStream(base, '', 'data.bin', Readable.from([Buffer.from('baru')]), { overwrite: true });
  assert.equal(r2.overwritten, true);
  assert.equal(fs.readFileSync(path.join(base, 'data.bin'), 'utf8'), 'baru');
  await rejects(F.uploadStream(base, '', 'big.bin', Readable.from([Buffer.alloc(2000)]), { maxBytes: 1000 }), 413);
  await rejects(F.uploadStream(base, '', '../evil', Readable.from([Buffer.from('x')])), 400);
  await rejects(F.uploadStream(base, 'tidak-ada', 'a', Readable.from([Buffer.from('x')])), 404);
  const broken = new Readable({ read() { this.push(Buffer.from('abc')); this.destroy(new Error('putus')); } });
  await assert.rejects(F.uploadStream(base, '', 'putus.bin', broken));
  const left = fs.readdirSync(base).filter(n => n.endsWith('.part') || n === 'putus.bin' || n === 'big.bin');
  assert.deepEqual(left, []);
});

/* ------------------------------------------------------------- zip.js */

async function makeTree(root) {
  await fsp.mkdir(path.join(root, 'proj/src/deep'), { recursive: true });
  await fsp.mkdir(path.join(root, 'proj/empty-dir'));
  await fsp.writeFile(path.join(root, 'proj/readme.md'), '# Halo\n'.repeat(500));
  await fsp.writeFile(path.join(root, 'proj/src/index.js'), 'console.log("hi")\n');
  await fsp.writeFile(path.join(root, 'proj/src/deep/rand.bin'), crypto.randomBytes(2 * 1024 * 1024));
  await fsp.writeFile(path.join(root, 'proj/src/deep/kosong.txt'), '');
  await fsp.writeFile(path.join(root, 'proj/nama é ü 日本.txt'), 'unicode');
  await fsp.writeFile(path.join(root, 'proj/run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  await fsp.writeFile(path.join(root, 'solo.txt'), 'file tunggal');
}

function sameTree(a, b) {
  const walk = d => {
    const out = {};
    const rec = (dir, rel) => {
      for (const n of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, n); const r = rel ? `${rel}/${n}` : n;
        const st = fs.lstatSync(full);
        if (st.isDirectory()) { out[`${r}/`] = 'dir'; rec(full, r); }
        else out[r] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
      }
    };
    rec(d, ''); return out;
  };
  assert.deepEqual(walk(a), walk(b));
}

test('buat ZIP: valid menurut unzip dan Python, isi identik, tanpa sekadar ganti ekstensi', async () => {
  const root = await tmp();
  await makeTree(root);
  const { entries, skipped } = await Z.collectEntries(root, ['proj', 'solo.txt']);
  assert.equal(skipped, 0);
  const zipFile = path.join(root, 'out.zip');
  const info = await Z.writeZip(entries, fs.createWriteStream(zipFile, { flags: 'wx' }));
  assert.equal(info.entries, entries.length);
  const head = fs.readFileSync(zipFile).subarray(0, 4);
  assert.deepEqual([...head], [0x50, 0x4b, 0x03, 0x04]);

  if (hasPython) {
    const out = py(`
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
names=z.namelist()
print('\\n'.join(names))
info={i.filename:i for i in z.infolist()}
assert info['proj/src/deep/rand.bin'].compress_type in (0,8)
assert info['proj/readme.md'].compress_size < info['proj/readme.md'].file_size/5, 'harus benar-benar terkompresi'
assert (info['proj/run.sh'].external_attr>>16)&0o111, 'bit eksekusi dipertahankan'
`, zipFile);
    assert.ok(out.includes('proj/empty-dir/'));
    assert.ok(out.includes('proj/nama é ü 日本.txt'));
  }
  if (hasUnzip) {
    execFileSync('unzip', ['-tq', zipFile]);
    const dest = path.join(root, 'by-unzip');
    fs.mkdirSync(dest);
    execFileSync('unzip', ['-q', zipFile, '-d', dest]);
    sameTree(path.join(root, 'proj'), path.join(dest, 'proj'));
    assert.equal(fs.readFileSync(path.join(dest, 'solo.txt'), 'utf8'), 'file tunggal');
  }
});

test('ekstrak ZIP buatan sendiri dengan extractor sendiri (round trip)', async () => {
  const root = await tmp();
  await makeTree(root);
  const { entries } = await Z.collectEntries(root, ['proj', 'solo.txt']);
  const zipFile = path.join(root, 'out.zip');
  await Z.writeZip(entries, fs.createWriteStream(zipFile, { flags: 'wx' }));
  const dest = path.join(root, 'dest'); await fsp.mkdir(dest);
  const stats = await Z.extractZip(zipFile, dest, { stageRoot: path.join(root, '.tmp') });
  assert.equal(stats.files, 7);
  sameTree(path.join(root, 'proj'), path.join(dest, 'proj'));
  assert.ok(fs.statSync(path.join(dest, 'proj/run.sh')).mode & 0o100, 'bit eksekusi');
  assert.deepEqual(fs.readdirSync(path.join(root, '.tmp')), [], 'staging dibersihkan');
});

test('ekstrak ZIP buatan Python (deflate + stored) dan zip CLI', { skip: !hasPython }, async () => {
  const root = await tmp();
  const zipFile = path.join(root, 'py.zip');
  py(`
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('a/b/c.txt','isi c'*100, zipfile.ZIP_DEFLATED)
z.writestr('stored.txt','tanpa kompresi', zipfile.ZIP_STORED)
z.writestr('folder/', '')
z.writestr('kosong.txt','')
z.close()`, zipFile);
  const dest = path.join(root, 'd'); await fsp.mkdir(dest);
  const st = await Z.extractZip(zipFile, dest, { stageRoot: path.join(root, '.tmp') });
  assert.equal(st.files, 3);
  assert.equal(fs.readFileSync(path.join(dest, 'a/b/c.txt'), 'utf8'), 'isi c'.repeat(100));
  assert.equal(fs.readFileSync(path.join(dest, 'stored.txt'), 'utf8'), 'tanpa kompresi');
  assert.ok(fs.statSync(path.join(dest, 'folder')).isDirectory());

  if (hasZip) {
    const src = path.join(root, 'src'); await fsp.mkdir(path.join(src, 'x'), { recursive: true });
    await fsp.writeFile(path.join(src, 'x/y.txt'), 'dari zip cli '.repeat(1000));
    const z2 = path.join(root, 'cli.zip');
    execFileSync('zip', ['-qr', z2, 'x'], { cwd: src });
    const d2 = path.join(root, 'd2'); await fsp.mkdir(d2);
    await Z.extractZip(z2, d2, { stageRoot: path.join(root, '.tmp') });
    assert.equal(fs.readFileSync(path.join(d2, 'x/y.txt'), 'utf8'), 'dari zip cli '.repeat(1000));
  }
});

test('ZIP Slip dan entri berbahaya ditolak seluruhnya, tanpa menulis apa pun', { skip: !hasPython }, async () => {
  const root = await tmp();
  const cases = ['../evil.txt', '/abs/evil.txt', 'a/../../evil.txt', 'C:\\\\evil.txt', '..\\\\evil.txt', 'ok/../../../evil.txt'];
  for (const [i, name] of cases.entries()) {
    const zipFile = path.join(root, `evil${i}.zip`);
    py(`
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('baik.txt','baik')
z.writestr(sys.argv[2],'jahat')
z.close()`, zipFile, name.replace(/\\\\/g, '\\'));
    const dest = path.join(root, `dest${i}`); await fsp.mkdir(dest);
    await rejects(Z.extractZip(zipFile, dest, { stageRoot: path.join(root, '.tmp') }), 400, 'ZIP_UNSAFE');
    assert.deepEqual(fs.readdirSync(dest), [], `dest harus kosong untuk ${name}`);
  }
  assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
  assert.equal(fs.existsSync('/tmp/evil.txt'), false);
});

test('symlink di dalam arsip dilewati, symlink pada jalur tujuan ditolak', { skip: !hasZip }, async () => {
  const root = await tmp();
  const src = path.join(root, 'src'); await fsp.mkdir(src);
  await fsp.writeFile(path.join(src, 'normal.txt'), 'ok');
  await fsp.symlink('/etc/passwd', path.join(src, 'link'));
  const zipFile = path.join(root, 'sym.zip');
  execFileSync('zip', ['-qry', zipFile, '.'], { cwd: src });
  const dest = path.join(root, 'dest'); await fsp.mkdir(dest);
  const st = await Z.extractZip(zipFile, dest, { stageRoot: path.join(root, '.tmp') });
  assert.equal(st.skipped, 1);
  assert.deepEqual(fs.readdirSync(dest), ['normal.txt']);

  // symlink di tujuan: zip berisi "inside/x.txt" tapi "inside" adalah symlink ke luar
  const outside = path.join(root, 'outside'); await fsp.mkdir(outside);
  const dest2 = path.join(root, 'dest2'); await fsp.mkdir(dest2);
  await fsp.symlink(outside, path.join(dest2, 'inside'));
  const z2 = path.join(root, 'z2.zip');
  const s2 = path.join(root, 's2'); await fsp.mkdir(path.join(s2, 'inside'), { recursive: true });
  await fsp.writeFile(path.join(s2, 'inside/x.txt'), 'jahat');
  execFileSync('zip', ['-qr', z2, 'inside'], { cwd: s2 });
  await rejects(Z.extractZip(z2, dest2, { stageRoot: path.join(root, '.tmp'), overwrite: true }), 409, 'ZIP_BLOCKED');
  assert.deepEqual(fs.readdirSync(outside), [], 'tidak ada file yang bocor ke luar');
});

test('konflik: tanpa overwrite tidak mengubah apa pun, dengan overwrite menimpa', async () => {
  const root = await tmp();
  const src = path.join(root, 'src'); await fsp.mkdir(src);
  await fsp.writeFile(path.join(src, 'a.txt'), 'BARU'); await fsp.writeFile(path.join(src, 'b.txt'), 'b baru');
  const { entries } = await Z.collectEntries(src, ['a.txt', 'b.txt']);
  const zipFile = path.join(root, 'z.zip');
  await Z.writeZip(entries, fs.createWriteStream(zipFile, { flags: 'wx' }));
  const dest = path.join(root, 'dest'); await fsp.mkdir(dest);
  await fsp.writeFile(path.join(dest, 'a.txt'), 'LAMA');

  const a = await Z.analyzeZip(zipFile, dest);
  assert.deepEqual(a.conflicts, ['a.txt']);
  await assert.rejects(Z.extractZip(zipFile, dest, { stageRoot: path.join(root, '.tmp') }), e => e.code === 'CONFLICT' && e.details.conflictCount === 1);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'LAMA');
  assert.equal(fs.existsSync(path.join(dest, 'b.txt')), false, 'tidak ada ekstraksi sebagian');

  const st = await Z.extractZip(zipFile, dest, { stageRoot: path.join(root, '.tmp'), overwrite: true });
  assert.equal(st.overwritten, 1);
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'BARU');
  assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'b baru');

  // ketidakcocokan tipe: folder di tujuan vs file di zip
  const d2 = path.join(root, 'd2'); await fsp.mkdir(path.join(d2, 'a.txt'), { recursive: true });
  await rejects(Z.extractZip(zipFile, d2, { stageRoot: path.join(root, '.tmp'), overwrite: true }), 409, 'ZIP_BLOCKED');
});

test('zip bomb, CRC rusak, batas ukuran, terenkripsi, bukan zip', { skip: !hasPython }, async () => {
  const root = await tmp();
  const dest = path.join(root, 'dest'); await fsp.mkdir(dest);
  const opts = { stageRoot: path.join(root, '.tmp') };

  // 1) ukuran deklarasi dipalsukan lebih kecil dari isi sebenarnya
  const bomb = path.join(root, 'bomb.zip');
  py(`
import zipfile,struct,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)
z.writestr('besar.txt','A'*100000)
z.close()
b=bytearray(open(sys.argv[1],'rb').read())
i=b.rfind(b'PK\\x01\\x02')
struct.pack_into('<I',b,i+24,10)  # usize palsu = 10
open(sys.argv[1],'wb').write(b)`, bomb);
  await rejects(Z.extractZip(bomb, dest, opts), 400, 'ZIP_BOMB');
  assert.deepEqual(fs.readdirSync(dest), []);

  // 2) data stored dirusak -> CRC mismatch, tidak ada file tertinggal
  const crc = path.join(root, 'crc.zip');
  py(`
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_STORED)
z.writestr('a.txt','isi yang sah')
z.writestr('b.txt','file kedua')
z.close()
b=bytearray(open(sys.argv[1],'rb').read())
j=b.find(b'isi yang sah'); b[j]^=0xFF
open(sys.argv[1],'wb').write(b)`, crc);
  await rejects(Z.extractZip(crc, dest, opts), 400, 'BAD_ZIP');
  assert.deepEqual(fs.readdirSync(dest), [], 'staging mencegah hasil sebagian');

  // 3) batas ukuran total
  const big = path.join(root, 'big.zip');
  py(`
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)
z.writestr('x.bin','0'*5_000_000)
z.close()`, big);
  await rejects(Z.extractZip(big, dest, { ...opts, limits: { ...Z.DEFAULT_LIMITS, maxTotalBytes: 1_000_000 } }), 413, 'ZIP_TOO_BIG');
  // 4) terlalu banyak entri
  await rejects(Z.extractZip(big, dest, { ...opts, limits: { ...Z.DEFAULT_LIMITS, maxEntries: 0 } }), 413, 'ZIP_TOO_MANY');

  // 5) bukan zip
  const fake = path.join(root, 'fake.zip');
  await fsp.writeFile(fake, 'ini cuma teks yang diganti ekstensinya'.repeat(5));
  await rejects(Z.analyzeZip(fake, dest), 400, 'BAD_ZIP');

  if (hasZip) {
    const enc = path.join(root, 'enc.zip');
    const s = path.join(root, 's'); await fsp.mkdir(s); await fsp.writeFile(path.join(s, 'r.txt'), 'rahasia');
    execFileSync('zip', ['-q', '-P', 'pw', enc, 'r.txt'], { cwd: s });
    await rejects(Z.analyzeZip(enc, dest), 415, 'ZIP_UNSUPPORTED');
  }
});

test('collectEntries melewati symlink dan mengecualikan path tertentu', async () => {
  const root = await tmp();
  await fsp.mkdir(path.join(root, 'd')); await fsp.writeFile(path.join(root, 'd/a'), '1'); await fsp.writeFile(path.join(root, 'd/b'), '2');
  await fsp.symlink('/etc', path.join(root, 'd/lnk'));
  const r = await Z.collectEntries(root, ['d'], { exclude: new Set([path.join(root, 'd/b')]) });
  assert.deepEqual(r.entries.map(e => e.name), ['d/', 'd/a']);
  assert.equal(r.skipped, 1);
});
