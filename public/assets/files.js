/* Henkaramazov Panel - File Manager & Editor */
(function () {
  'use strict';
  const { $, esc, api, icon } = P;

  const fm = { path: '', items: [], selected: new Set(), token: 0, loaded: false, error: '' };
  const ed = { open: false, path: '', name: '', original: '', dirty: false, cm: null, fallback: false, token: 0 };
  const DOWNLOAD_BLOB_LIMIT = 50 * 1024 * 1024; // di atas ini, unduh langsung oleh browser

  const sid = () => P.state.selectedId;
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const enc = encodeURIComponent;
  const sv = suffix => `/api/servers/${sid()}/${suffix}`;

  /* ------------------------------------------------------ jenis file */
  const LANGS = {
    js: ['JavaScript', 'javascript'], mjs: ['JavaScript', 'javascript'], cjs: ['JavaScript', 'javascript'], jsx: ['JSX', 'javascript'],
    ts: ['TypeScript', { name: 'javascript', typescript: true }], json: ['JSON', { name: 'javascript', json: true }],
    html: ['HTML', 'htmlmixed'], htm: ['HTML', 'htmlmixed'], vue: ['Vue', 'htmlmixed'],
    xml: ['XML', 'xml'], svg: ['SVG', 'xml'], css: ['CSS', 'css'], md: ['Markdown', 'markdown'],
    py: ['Python', 'python'], sh: ['Shell', 'shell'], bash: ['Shell', 'shell'], zsh: ['Shell', 'shell'],
    yml: ['YAML', 'yaml'], yaml: ['YAML', 'yaml'], sql: ['SQL', 'text/x-sql'],
    env: ['ENV', 'properties'], properties: ['Properties', 'properties'], ini: ['INI', 'properties'], conf: ['Config', 'properties'],
    txt: ['Teks', null], log: ['Log', null]
  };
  const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'zip', 'gz', 'tgz', 'rar', '7z', 'tar', 'xz', 'bz2', 'mp3', 'wav', 'ogg', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'pdf', 'exe', 'dll', 'so', 'bin', 'woff', 'woff2', 'ttf', 'otf', 'sqlite', 'sqlite3', 'db', 'jar', 'apk', 'class', 'node', 'wasm']);
  const ext = name => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; };
  const langFor = name => {
    if (/^dockerfile$/i.test(name)) return ['Docker', 'shell'];
    if (/^makefile$/i.test(name)) return ['Makefile', 'shell'];
    return LANGS[ext(name)] || ['Teks', null];
  };
  const typeLabel = item => (item.type === 'directory' ? 'Folder' : (ext(item.name) ? ext(item.name).toUpperCase() : 'File'));
  const isZip = name => /\.zip$/i.test(name);

  /* ---------------------------------------------------- daftar file */
  function crumbs() {
    const s = P.selected();
    const parts = fm.path ? fm.path.split('/') : [];
    let html = `<button type="button" data-go="">${icon('server')}</button>`;
    html = `<button type="button" data-go="" title="Root server">${esc(s ? s.name : 'root')}</button>`;
    let acc = '';
    parts.forEach(seg => {
      acc = join(acc, seg);
      html += `<span class="sep">/</span><button type="button" data-go="${esc(acc)}">${esc(seg)}</button>`;
    });
    const el = $('#fmCrumbs');
    el.innerHTML = html;
    el.scrollLeft = el.scrollWidth;
  }

  function rowHtml(item) {
    const isDir = item.type === 'directory';
    const ic = isDir ? 'folder' : (isZip(item.name) ? 'archive' : (LANGS[ext(item.name)] && LANGS[ext(item.name)][1] ? 'code' : 'file'));
    const checked = fm.selected.has(item.name);
    const sub = `${typeLabel(item)}${isDir ? '' : ` · ${P.formatSize(item.size)}`} · ${P.formatDate(item.mtime)}`;
    return `<div class="fm-row ${checked ? 'sel' : ''}" role="listitem" data-name="${esc(item.name)}" data-type="${item.type}">
      <label class="chk"><input type="checkbox" data-sel ${checked ? 'checked' : ''} aria-label="Pilih ${esc(item.name)}"><span class="box"></span></label>
      <button type="button" class="fm-name" data-open><span class="fm-ic">${icon(ic)}</span><span class="fm-text"><b>${esc(item.name)}${item.link ? '<span class="link-tag">link</span>' : ''}</b><span class="fm-sub">${esc(sub)}</span></span></button>
      <span class="fm-col">${esc(typeLabel(item))}</span><span class="fm-col">${isDir ? '-' : P.formatSize(item.size)}</span><span class="fm-col">${P.formatDate(item.mtime)}</span>
      <button type="button" class="fm-more" data-more aria-label="Aksi untuk ${esc(item.name)}">${icon('more')}</button>
    </div>`;
  }

  function render() {
    crumbs();
    const list = $('#fmList');
    if (fm.error) {
      list.innerHTML = `<div class="fm-empty">${esc(fm.error)}<br><br><button type="button" class="btn btn-ghost btn-sm" data-retry>Coba lagi</button></div>`;
    } else if (!fm.loaded) {
      list.innerHTML = '<div class="fm-loading">Memuat file...</div>';
    } else {
      let html = '';
      if (fm.path) {
        html += `<div class="fm-row" role="listitem"><span></span><button type="button" class="fm-name" data-up><span class="fm-ic">${icon('arrowLeft')}</span><span class="fm-text"><b>.. (naik satu folder)</b></span></button><span></span></div>`;
      }
      html += fm.items.map(rowHtml).join('');
      if (!fm.items.length) html += '<div class="fm-empty">Folder ini kosong. Buat file baru atau upload dari perangkatmu.</div>';
      list.innerHTML = html;
    }
    updateBar();
  }

  function updateBar() {
    const n = fm.selected.size;
    const total = fm.items.length;
    $('#fmSelBar').classList.toggle('active', n > 0);
    $('#fmSelCount').textContent = `${n} dipilih`;
    const all = $('#fmCheckAll');
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
    all.disabled = total === 0;
    $('#fmSelectAll').disabled = total === 0 || n === total;
    $('#fmClearSel').disabled = n === 0;
    $('#fmZipSel').disabled = n === 0;
    $('#fmDeleteSel').disabled = n === 0;
  }

  async function load({ quiet = false } = {}) {
    const id = sid();
    if (!id) return;
    const token = ++fm.token;
    if (!quiet) { fm.loaded = false; fm.error = ''; render(); }
    try {
      const data = await api(`/api/servers/${id}/files?path=${enc(fm.path)}`);
      if (token !== fm.token || id !== sid()) return;
      fm.items = data.items;
      fm.loaded = true; fm.error = '';
      const names = new Set(fm.items.map(i => i.name));
      fm.selected = new Set([...fm.selected].filter(n => names.has(n)));
    } catch (e) {
      if (token !== fm.token || id !== sid()) return;
      if (e.status === 404 && fm.path) { fm.path = ''; fm.selected.clear(); return load(); }
      fm.items = []; fm.loaded = true; fm.error = e.message;
    }
    render();
  }

  function go(path) { fm.path = path; fm.selected.clear(); load(); }

  /* --------------------------------------------------------- aksi */
  async function openItem(item) {
    if (item.type === 'directory') return go(join(fm.path, item.name));
    if (isZip(item.name)) return itemMenu(item);
    if (BINARY_EXT.has(ext(item.name))) {
      P.toast('File biner tidak bisa diedit. Gunakan Download dari menu ⋯.');
      return itemMenu(item);
    }
    return openEditor(join(fm.path, item.name), item.name);
  }

  function itemMenu(item) {
    const isDir = item.type === 'directory';
    const actions = [];
    actions.push({ label: isDir ? 'Buka folder' : (isZip(item.name) || BINARY_EXT.has(ext(item.name)) ? null : 'Edit file'), icon: isDir ? 'folder' : 'edit', run: () => (isDir ? go(join(fm.path, item.name)) : openEditor(join(fm.path, item.name), item.name)) });
    if (!actions[0].label) actions.shift();
    if (!isDir && isZip(item.name)) actions.push({ label: 'Ekstrak ZIP...', icon: 'archive', run: () => extractExisting(item) });
    actions.push({ label: 'Rename', icon: 'pencil', run: () => renameItem(item) });
    actions.push({ label: isDir ? 'Download (ZIP)' : 'Download', icon: 'download', run: () => download(item) });
    actions.push({ label: 'Hapus', icon: 'trash', danger: true, run: () => deleteNames([item.name]) });
    return P.sheet(join(fm.path, item.name) || item.name, actions);
  }

  async function newFile() {
    const id = sid(); const dir = fm.path;
    const name = await P.prompt({ title: 'File baru', label: 'Nama file', placeholder: 'contoh: index.js', confirmText: 'Buat file' });
    if (!name) return;
    try {
      await api(`/api/servers/${id}/file`, { method: 'POST', body: { dir, name, content: '' } });
      P.ok(`File "${name}" dibuat.`);
      if (id !== sid()) return;
      await load({ quiet: true });
      if (!BINARY_EXT.has(ext(name)) && dir === fm.path) openEditor(join(dir, name), name);
    } catch (e) { P.fail(e); }
  }

  async function newFolder() {
    const id = sid(); const dir = fm.path;
    const name = await P.prompt({ title: 'Folder baru', label: 'Nama folder', placeholder: 'contoh: src', confirmText: 'Buat folder' });
    if (!name) return;
    try {
      await api(`/api/servers/${id}/folder`, { method: 'POST', body: { dir, name } });
      P.ok(`Folder "${name}" dibuat.`);
      if (id === sid()) load({ quiet: true });
    } catch (e) { P.fail(e); }
  }

  async function renameItem(item) {
    const id = sid(); const rel = join(fm.path, item.name);
    const newName = await P.prompt({ title: `Rename ${item.type === 'directory' ? 'folder' : 'file'}`, label: 'Nama baru', value: item.name, confirmText: 'Rename', validate: v => (!v ? 'Tidak boleh kosong.' : v === item.name ? 'Nama sama dengan sebelumnya.' : /[\/\\]/.test(v) ? 'Tidak boleh mengandung / atau \\.' : '') });
    if (!newName) return;
    try {
      await api(`/api/servers/${id}/rename`, { method: 'POST', body: { path: rel, newName } });
      P.ok(`Diubah menjadi "${newName}".`);
      fm.selected.delete(item.name);
      if (id === sid()) load({ quiet: true });
    } catch (e) { P.fail(e); }
  }

  async function deleteNames(names) {
    const id = sid(); const dir = fm.path;
    const hasDir = names.some(n => (fm.items.find(i => i.name === n) || {}).type === 'directory');
    const ok = await P.confirm({
      title: names.length === 1 ? `Hapus "${names[0]}"?` : `Hapus ${names.length} item?`,
      message: `Item akan dihapus permanen dari server.${hasDir ? ' Isi folder juga ikut terhapus.' : ''} Tindakan ini tidak bisa dibatalkan.`,
      items: names.length > 1 ? names : null, confirmText: 'Hapus', danger: true
    });
    if (!ok) return;
    try {
      const r = await api(`/api/servers/${id}/delete`, { method: 'POST', body: { dir, names } });
      const bad = r.results.filter(x => !x.ok);
      if (bad.length) P.toast(`${r.results.length - bad.length} terhapus, ${bad.length} gagal: ${bad[0].name} (${bad[0].error})`, 'err');
      else P.ok(`${r.results.length} item dihapus.`);
      names.forEach(n => fm.selected.delete(n));
      if (id === sid()) load({ quiet: true });
    } catch (e) { P.fail(e); }
  }

  /* ----------------------------------------------------- download */
  function directDownload(href) {
    const a = document.createElement('a');
    a.href = href; a.download = ''; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }

  function download(item, relOverride) {
    const id = sid();
    const rel = relOverride || join(fm.path, item.name);
    const href = `/api/servers/${id}/download?path=${enc(rel)}`;
    if (item.type === 'directory' || (item.size || 0) > DOWNLOAD_BLOB_LIMIT) {
      directDownload(href);
      P.toast(item.type === 'directory' ? 'Menyiapkan ZIP folder... unduhan akan dimulai oleh browser.' : 'Unduhan dimulai oleh browser.');
      return;
    }
    const t = P.transfer(`Download ${item.name}`);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', href);
    xhr.responseType = 'blob';
    xhr.onprogress = e => { if (e.lengthComputable) t.update(e.loaded / e.total); };
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const url = URL.createObjectURL(xhr.response);
        const a = document.createElement('a');
        a.href = url; a.download = item.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        t.done(P.formatSize(xhr.response.size));
      } else {
        let msg = `Download gagal (${xhr.status}).`;
        try { msg = JSON.parse(await xhr.response.text()).error || msg; } catch {}
        t.fail(msg);
      }
    };
    xhr.onerror = () => t.fail('Koneksi terputus saat download.');
    xhr.send();
  }

  /* ------------------------------------------------------- upload */
  function uploadFile(id, dir, file, name, overwrite, t) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/servers/${id}/upload?path=${enc(dir)}&name=${enc(name)}&overwrite=${overwrite ? 1 : 0}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = e => { if (e.lengthComputable) t.update(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          if (xhr.status === 401) P.emit('unauthorized');
          reject(Object.assign(new Error(data.error || `Upload gagal (${xhr.status}).`), { code: data.code, status: xhr.status }));
        }
      };
      xhr.onerror = () => reject(new Error('Koneksi terputus saat upload.'));
      xhr.onabort = () => reject(new Error('Upload dibatalkan.'));
      xhr.send(file);
    });
  }

  async function uploadFiles(fileList) {
    const id = sid(); const dir = fm.path;
    const picked = Array.from(fileList);
    $('#uploadInput').value = '';
    if (!picked.length) return;
    const max = P.state.limits.maxUploadBytes;
    const files = picked.filter(f => {
      if (f.size > max) { P.toast(`"${f.name}" dilewati: melebihi batas ${P.formatSize(max)}.`, 'err'); return false; }
      return true;
    });
    if (!files.length) return;
    const existing = new Set(fm.items.map(i => i.name));
    const dups = files.filter(f => existing.has(f.name)).map(f => f.name);
    if (dups.length) {
      const ok = await P.confirm({ title: 'Timpa file yang sudah ada?', message: `${dups.length} file dengan nama sama sudah ada di folder ini dan akan ditimpa:`, items: dups, confirmText: 'Timpa & upload', danger: true });
      if (!ok) return;
    }
    let success = 0;
    for (const file of files) {
      const t = P.transfer(`Upload ${file.name}`);
      try {
        await uploadFile(id, dir, file, file.name, dups.includes(file.name), t);
        t.done(P.formatSize(file.size));
        success++;
      } catch (e) { t.fail(e.message); }
    }
    if (success && id === sid()) { if (dir === fm.path) await load({ quiet: true }); }
  }

  /* ------------------------------------------------------ zip/unzip */
  function stamp() {
    const d = new Date(); const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function zipSelected() {
    const id = sid(); const dir = fm.path;
    const names = [...fm.selected];
    if (!names.length) return;
    const baseName = (dir ? dir.split('/').pop() : (P.selected() ? P.selected().id : 'arsip')) || 'arsip';
    const zipName = await P.prompt({
      title: 'Buat ZIP', message: `${names.length} item dipilih akan dikompres.`, label: 'Nama file ZIP', value: `${baseName}-${stamp()}.zip`, confirmText: 'Buat ZIP',
      validate: v => (!v ? 'Tidak boleh kosong.' : /[\/\\]/.test(v) ? 'Tidak boleh mengandung / atau \\.' : '')
    });
    if (!zipName) return;
    const t = P.transfer(`Membuat ${zipName}`, { indeterminate: true });
    let overwrite = false;
    for (;;) {
      try {
        const r = await api(`/api/servers/${id}/zip`, { method: 'POST', body: { dir, names, zipName, overwrite } });
        t.done(`${r.files} file · ${P.formatSize(r.size)}${r.skippedLinks ? ` · ${r.skippedLinks} symlink dilewati` : ''}`, { label: 'Download ZIP', run: () => download({ name: r.name, type: 'file', size: r.size }, r.path) });
        fm.selected.clear();
        if (id === sid()) load({ quiet: true });
        return;
      } catch (e) {
        if (e.code === 'EXISTS' && !overwrite) {
          const ok = await P.confirm({ title: 'Timpa ZIP yang ada?', message: `"${zipName}" sudah ada. Timpa dengan ZIP baru?`, confirmText: 'Timpa', danger: true });
          if (ok) { overwrite = true; continue; }
          t.close(); return;
        }
        t.fail(e.message); return;
      }
    }
  }

  /**
   * Alur ekstraksi: cek (konflik/arsip berbahaya) -> konfirmasi jika menimpa -> ekstrak.
   * Mengembalikan true bila sukses.
   */
  async function extractFlow(id, zipRel, dest) {
    const t = P.transfer('Memeriksa isi ZIP...', { indeterminate: true });
    let check;
    try { check = await api(`/api/servers/${id}/extract/check`, { method: 'POST', body: { path: zipRel, dest } }); }
    catch (e) { t.fail(e.message); return false; }
    t.close();
    if (!check.ok) {
      await P.dialog({ title: 'Ekstraksi ditolak', message: check.blocking.join('\n'), confirmText: 'Tutup', cancelText: false, danger: true });
      return false;
    }
    const where = `/${dest}`.replace(/\/$/, '') || '/';
    if (check.conflictCount > 0) {
      const ok = await P.dialog({
        title: 'Timpa file yang ada?',
        message: `Mengekstrak ${check.files} file (${P.formatSize(check.totalBytes)}) ke "${where}". ${check.conflictCount} file sudah ada dan akan DITIMPA:`,
        items: check.conflicts, confirmText: 'Timpa & ekstrak', danger: true
      });
      if (!ok) return false;
    }
    const tx = P.transfer('Mengekstrak ZIP...', { indeterminate: true });
    tx.text(`${check.files} file · ${P.formatSize(check.totalBytes)}`);
    try {
      const r = await api(`/api/servers/${id}/extract`, { method: 'POST', body: { path: zipRel, dest, overwrite: check.conflictCount > 0 } });
      tx.done(`${r.files} file diekstrak${r.overwritten ? `, ${r.overwritten} ditimpa` : ''}${r.skipped ? `, ${r.skipped} symlink dilewati` : ''}`);
      return true;
    } catch (e) {
      tx.fail(e.message);
      return false;
    }
  }

  async function extractExisting(item) {
    const id = sid(); const dir = fm.path;
    const dest = await P.prompt({ title: 'Ekstrak ZIP', message: `Ekstrak "${item.name}" ke folder mana? Kosongkan untuk root server. Folder harus sudah ada.`, label: 'Folder tujuan', value: dir, confirmText: 'Lanjut', validate: () => '' });
    if (dest === null) return;
    if (await extractFlow(id, join(dir, item.name), dest.replace(/^\/+|\/+$/g, ''))) { if (id === sid()) load({ quiet: true }); }
  }

  async function uploadZipAndExtract(fileList) {
    const id = sid(); const dir = fm.path;
    const file = fileList && fileList[0];
    $('#uploadZipInput').value = '';
    if (!file) return;
    if (!isZip(file.name)) return P.toast('Pilih file dengan ekstensi .zip.', 'err');
    if (file.size > P.state.limits.maxUploadBytes) return P.toast(`File melebihi batas upload ${P.formatSize(P.state.limits.maxUploadBytes)}.`, 'err');
    const tmpName = `.upload-${Date.now().toString(36)}.zip`;
    const t = P.transfer(`Upload ${file.name}`);
    try { await uploadFile(id, dir, file, tmpName, false, t); t.done(P.formatSize(file.size)); }
    catch (e) { t.fail(e.message); return; }
    try { await extractFlow(id, join(dir, tmpName), dir); }
    finally {
      await api(`/api/servers/${id}/delete`, { method: 'POST', body: { dir, names: [tmpName] } }).catch(() => {});
      if (id === sid()) load({ quiet: true });
    }
  }

  /* ---------------------------------------------------------- editor */
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/';
  const LOCAL = '/assets/vendor/codemirror/';
  const MODES = ['javascript/javascript', 'xml/xml', 'css/css', 'htmlmixed/htmlmixed', 'markdown/markdown', 'python/python', 'shell/shell', 'yaml/yaml', 'sql/sql', 'properties/properties'];
  let cmLoading = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = resolve; s.onerror = () => { s.remove(); reject(new Error(`Gagal memuat ${src}`)); };
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    return new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      l.onload = resolve; l.onerror = () => { l.remove(); reject(new Error(`Gagal memuat ${href}`)); };
      document.head.appendChild(l);
    });
  }
  // Coba salinan lokal (/assets/vendor/codemirror/, untuk mode offline) lalu CDN.
  function loadCodeMirror() {
    if (window.CodeMirror) return Promise.resolve(true);
    if (cmLoading) return cmLoading;
    cmLoading = (async () => {
      for (const base of [LOCAL, CDN]) {
        try {
          await Promise.all([loadCss(`${base}codemirror.min.css`), loadScript(`${base}codemirror.min.js`)]);
          await Promise.all([...MODES.map(m => `mode/${m}.min.js`), 'addon/edit/matchbrackets.min.js', 'addon/selection/active-line.min.js'].map(f => loadScript(`${base}${f}`).catch(() => null)));
          return true;
        } catch { /* coba sumber berikutnya */ }
      }
      return false;
    })();
    return cmLoading;
  }

  const edGet = () => (ed.fallback ? $('#edFallback').value : ed.cm.getValue());
  function edSet(text) { if (ed.fallback) $('#edFallback').value = text; else ed.cm.setValue(text); }

  function setDirty(v) {
    ed.dirty = v;
    $('#edDirty').classList.toggle('hidden', !v);
  }
  function onEdit() { if (ed.open) setDirty(edGet() !== ed.original); }

  async function ensureEditor() {
    if (ed.cm || ed.fallback) return;
    const ok = await loadCodeMirror();
    if (ok && window.CodeMirror) {
      ed.cm = window.CodeMirror($('#cmHost'), {
        value: '', lineNumbers: true, theme: 'henka', indentUnit: 2, tabSize: 2, indentWithTabs: false,
        lineWrapping: window.innerWidth < 760, matchBrackets: true, styleActiveLine: true, viewportMargin: 30,
        extraKeys: {
          'Ctrl-S': () => saveFile(), 'Cmd-S': () => saveFile(),
          Tab: cm => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  ', 'end')),
          'Shift-Tab': cm => cm.indentSelection('subtract')
        }
      });
      ed.cm.on('change', onEdit);
    } else {
      ed.fallback = true;
      $('#cmHost').classList.add('hidden');
      const ta = $('#edFallback');
      ta.classList.remove('hidden');
      ta.addEventListener('input', onEdit);
      ta.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
        if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); onEdit(); }
      });
    }
  }

  async function openEditor(rel, name) {
    const id = sid();
    const token = ++ed.token;
    let data;
    try { data = await api(`/api/servers/${id}/file?path=${enc(rel)}`); }
    catch (e) { P.fail(e); return; }
    if (token !== ed.token || id !== sid()) return;
    await ensureEditor();
    if (token !== ed.token || id !== sid()) return;

    const [label, mode] = langFor(name);
    ed.open = true; ed.path = rel; ed.name = name; ed.original = data.content;
    $('#fmView').classList.add('hidden');
    $('#editorView').classList.remove('hidden');
    $('#edName').textContent = name;
    $('#edPath').textContent = `/${rel}`;
    $('#edLang').textContent = label;
    $('#edError').classList.add('hidden');
    const notice = $('#edNotice');
    notice.classList.toggle('hidden', !ed.fallback);
    if (ed.fallback) notice.textContent = 'Syntax highlighting tidak aktif (CodeMirror gagal dimuat). Memakai editor teks biasa. Lihat README untuk mode offline.';
    edSet(data.content);
    if (ed.cm) { ed.cm.setOption('mode', mode); ed.cm.clearHistory(); ed.cm.refresh(); }
    setDirty(false);
    if (window.innerWidth >= 760) { if (ed.cm) ed.cm.focus(); else $('#edFallback').focus(); }
    window.scrollTo(0, 0);
  }

  async function saveFile() {
    if (!ed.open) return false;
    const id = sid(); const rel = ed.path; const content = edGet();
    const btn = $('#edSave');
    btn.disabled = true;
    try {
      await api(`/api/servers/${id}/file`, { method: 'PUT', body: { path: rel, content } });
      if (ed.open && ed.path === rel && id === sid()) {
        ed.original = content;
        setDirty(edGet() !== ed.original);
        $('#edError').classList.add('hidden');
      }
      P.ok(`"${ed.name}" disimpan.`);
      return true;
    } catch (e) {
      const box = $('#edError');
      box.textContent = `Gagal menyimpan: ${e.message}`;
      box.classList.remove('hidden');
      P.fail(e);
      return false;
    } finally { btn.disabled = false; }
  }

  function closeEditor() {
    ed.open = false; ed.token++; ed.original = ''; setDirty(false);
    $('#editorView').classList.add('hidden');
    $('#fmView').classList.remove('hidden');
    $('#edError').classList.add('hidden');
    if (ed.cm) ed.cm.setValue('');
    if (ed.fallback) $('#edFallback').value = '';
  }

  async function backFromEditor() {
    if (ed.dirty) {
      const ok = await P.confirm({ title: 'Buang perubahan?', message: `"${ed.name}" memiliki perubahan yang belum disimpan.`, confirmText: 'Buang perubahan', danger: true });
      if (!ok) return;
    }
    closeEditor();
    load({ quiet: true });
  }

  /* ------------------------------------------------------- binding */
  function bind() {
    $('#fmList').addEventListener('click', e => {
      if (e.target.closest('[data-retry]')) return load();
      if (e.target.closest('[data-up]')) return go(fm.path.split('/').slice(0, -1).join('/'));
      const row = e.target.closest('.fm-row[data-name]');
      if (!row) return;
      const item = fm.items.find(i => i.name === row.dataset.name);
      if (!item) return;
      if (e.target.closest('[data-more]')) return itemMenu(item);
      if (e.target.closest('[data-open]')) return openItem(item);
    });
    $('#fmList').addEventListener('change', e => {
      const box = e.target.closest('[data-sel]');
      if (!box) return;
      const row = box.closest('.fm-row');
      if (box.checked) fm.selected.add(row.dataset.name); else fm.selected.delete(row.dataset.name);
      row.classList.toggle('sel', box.checked);
      updateBar();
    });
    $('#fmCrumbs').addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
    $('#fmCheckAll').addEventListener('change', e => { fm.selected = e.target.checked ? new Set(fm.items.map(i => i.name)) : new Set(); render(); });
    $('#fmSelectAll').onclick = () => { fm.selected = new Set(fm.items.map(i => i.name)); render(); };
    $('#fmClearSel').onclick = () => { fm.selected.clear(); render(); };
    $('#fmDeleteSel').onclick = () => deleteNames([...fm.selected]);
    $('#fmZipSel').onclick = zipSelected;
    $('#fmNewFile').onclick = newFile;
    $('#fmNewFolder').onclick = newFolder;
    $('#fmRefresh').onclick = () => load();
    $('#fmUpload').onclick = () => $('#uploadInput').click();
    $('#fmUploadZip').onclick = () => $('#uploadZipInput').click();
    $('#uploadInput').addEventListener('change', e => uploadFiles(e.target.files));
    $('#uploadZipInput').addEventListener('change', e => uploadZipAndExtract(e.target.files));
    $('#edSave').onclick = saveFile;
    $('#edBack').onclick = backFromEditor;
    window.addEventListener('beforeunload', e => { if (ed.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }
  bind();

  /* ---------------------------------------------------------- publik */
  P.files = {
    onShow() { if (!ed.open) { fm.loaded && fm.items.length ? load({ quiet: true }) : load(); } else if (ed.cm) ed.cm.refresh(); },
    reset() {
      fm.path = ''; fm.items = []; fm.selected.clear(); fm.loaded = false; fm.error = ''; fm.token++;
      if (ed.open) closeEditor();
      render();
    },
    isDirty: () => ed.dirty,
    async canLeave() {
      if (!ed.dirty) return true;
      return P.confirm({ title: 'Perubahan belum disimpan', message: `"${ed.name}" memiliki perubahan yang belum disimpan. Tinggalkan halaman dan buang perubahan?`, confirmText: 'Buang perubahan', danger: true });
    },
    refreshAfterServerChange() { render(); }
  };
})();
