/* Henkaramazov Panel - aplikasi utama: login, router, daftar server, console, setting */
(function () {
  'use strict';
  const { $, $$, esc, api, icon } = P;
  const PAGES = ['servers', 'console', 'files', 'settings'];
  const TITLES = { servers: 'Daftar Server', console: 'Console', files: 'File Manager', settings: 'Setting Server' };
  const S = P.state;
  let socket = null;
  let currentPage = null;
  let pollTimer = null;
  let statusTimer = null;
  let tickTimer = null;

  /* ------------------------------------------------------------ server */
  const byId = id => S.servers.find(s => s.id === id);
  const statusChip = st => `<span class="chip ${st === 'running' ? 'running' : ''}">${st === 'running' ? 'Running' : 'Offline'}</span>`;

  async function loadServers({ quiet = false } = {}) {
    try {
      S.servers = await api('/api/servers');
      S.serversLoaded = true;
      if (S.selectedId && !byId(S.selectedId)) setSelected(null, true);
      if (!S.selectedId && S.servers.length === 1) setSelected(S.servers[0].id, true);
      renderAll();
    } catch (e) { if (!quiet && !e.status) P.fail(e); }
  }

  function persistSelected() { try { if (S.selectedId) localStorage.setItem('henka.selected', S.selectedId); else localStorage.removeItem('henka.selected'); } catch {} }

  // Mengubah pilihan tanpa guard (dipakai internal). Reset modul yang bergantung pada server.
  function setSelected(id, silent) {
    if (S.selectedId === id) return;
    if (S.selectedId && socket) socket.emit('leave-server', S.selectedId);
    S.selectedId = id;
    persistSelected();
    P.files.reset();
    resetConsole();
    joinConsole();
    if (!silent) renderAll();
  }

  P.selectServer = async id => {
    if (S.selectedId === id) return true;
    if (!(await P.files.canLeave())) return false;
    setSelected(id);
    return true;
  };

  function renderAll() {
    renderServers();
    renderCtx();
    renderConsoleState();
    renderSettings();
  }

  /* ------------------------------------------------------ daftar server */
  function renderServers() {
    const running = S.servers.filter(s => s.status === 'running').length;
    $('#serversSub').textContent = S.serversLoaded ? (S.servers.length ? 'Pilih server untuk dikelola, atau buka langsung Console, File dan Setting-nya.' : 'Belum ada server terdaftar.') : 'Memuat server...';
    $('#statRow').innerHTML = S.servers.length
      ? `<div class="stat"><strong>${S.servers.length}</strong><span>Total server</span></div><div class="stat ${running ? 'live' : ''}"><strong>${running}</strong><span>Sedang berjalan</span></div><div class="stat"><strong>${S.servers.length - running}</strong><span>Offline</span></div>`
      : '';
    $('#serverEmpty').classList.toggle('hidden', !S.serversLoaded || S.servers.length > 0);
    $('#serverList').innerHTML = S.servers.map(s => {
      const sel = s.id === S.selectedId;
      const up = s.status === 'running' && s.startedAt ? `Aktif ${P.formatDuration(Date.now() - s.startedAt)}` : (s.lastExit ? `Berhenti (kode ${s.lastExit.code ?? '-'})` : 'Belum dijalankan');
      return `<article class="server-card ${sel ? 'selected' : ''}" data-id="${esc(s.id)}" tabindex="0" aria-label="Server ${esc(s.name)}">
        <div class="sc-top"><div><div class="sc-name">${esc(s.name)}</div><div class="sc-id">${esc(s.directory)}</div></div>${statusChip(s.status)}</div>
        <div class="sc-meta">${sel ? '<span class="sel-badge">Dipilih</span>' : ''}<span>${esc(up)}</span>${s.pid ? `<span>PID ${s.pid}</span>` : ''}</div>
        <div class="sc-actions">
          <button class="btn btn-ghost" data-act="console" type="button">${icon('terminal')}<span>Console</span></button>
          <button class="btn btn-ghost" data-act="files" type="button">${icon('folder')}<span>File</span></button>
          <button class="btn btn-ghost" data-act="settings" type="button">${icon('sliders')}<span>Setting</span></button>
          <button class="btn ${s.status === 'running' ? 'btn-danger' : 'btn-primary'} icon-only" data-act="power" type="button" title="${s.status === 'running' ? 'Stop' : 'Start'}" aria-label="${s.status === 'running' ? 'Stop' : 'Start'} ${esc(s.name)}">${icon(s.status === 'running' ? 'stop' : 'play')}</button>
        </div></article>`;
    }).join('');
  }

  async function power(s) {
    try {
      await api(`/api/servers/${s.id}/${s.status === 'running' ? 'stop' : 'start'}`, { method: 'POST', body: {} });
      P.ok(s.status === 'running' ? 'Perintah stop dikirim.' : 'Server dijalankan.');
      setTimeout(() => loadServers({ quiet: true }), 400);
    } catch (e) { P.fail(e); }
  }

  $('#serverList').addEventListener('click', async e => {
    const card = e.target.closest('.server-card');
    if (!card) return;
    const s = byId(card.dataset.id);
    if (!s) return;
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'power') return power(s);
    if (!(await P.selectServer(s.id))) return;
    if (act) location.hash = `#/${act.dataset.act}`;
    else { renderServers(); renderCtx(); P.toast(`"${s.name}" dipilih.`, 'ok'); }
  });
  $('#serverList').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('server-card')) { e.preventDefault(); e.target.click(); }
  });

  async function createServerDialog() {
    let orphans = [];
    try { orphans = await api('/api/servers/orphans'); } catch {}
    const fields = [];
    if (orphans.length) fields.push({ name: 'mode', type: 'radio', value: 'new', options: [{ value: 'new', label: 'Buat server baru', hint: 'Folder baru di servers/ otomatis dibuat.' }, { value: 'adopt', label: 'Tambahkan folder yang sudah ada', hint: `${orphans.length} folder di servers/ belum terdaftar.` }] });
    fields.push({ name: 'name', label: 'Nama server', placeholder: 'Contoh: Telegram Bot' });
    fields.push({ name: 'template', type: 'radio', value: 'node', showIf: v => v.mode !== 'adopt', options: [{ value: 'node', label: 'Node.js starter', hint: 'Membuat index.js dan package.json (scripts.start).' }, { value: 'empty', label: 'Folder kosong', hint: 'Upload project kamu sendiri (mis. lewat ZIP).' }] });
    if (orphans.length) fields.push({ name: 'folder', type: 'radio', value: orphans[0], showIf: v => v.mode === 'adopt', options: orphans.map(o => ({ value: o, label: `servers/${o}` })) });
    const v = await P.dialog({
      title: 'Tambah Server', fields, confirmText: 'Simpan',
      validate: x => (x.name.trim() ? (/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,39}$/.test(x.name.trim()) ? '' : 'Nama 1-40 karakter: huruf, angka, spasi, titik, _ atau -.') : 'Nama server wajib diisi.')
    });
    if (!v) return;
    try {
      const body = { name: v.name.trim() };
      if (v.mode === 'adopt') body.folder = v.folder; else body.template = v.template || 'node';
      const s = await api('/api/servers', { method: 'POST', body });
      await loadServers();
      await P.selectServer(s.id);
      P.ok(`Server "${s.name}" ditambahkan dan dipilih.`);
      renderAll();
    } catch (e) { P.fail(e); }
  }
  $('#newServerBtn').onclick = $('#emptyCreate').onclick = createServerDialog;
  $('#refreshServers').onclick = () => loadServers();

  /* ------------------------------------------------------- context bar */
  function renderCtx() {
    const s = P.selected();
    $$('[data-ctx]').forEach(el => {
      el.classList.toggle('hidden', !s);
      el.innerHTML = s ? `<div class="ctx-main"><span class="ctx-label">Server dipilih</span><strong class="ctx-name">${esc(s.name)}</strong>${statusChip(s.status)}</div><a class="btn btn-ghost btn-sm" href="#/servers">${icon('swap')}<span>Ganti</span></a>` : '';
    });
    ['console', 'files', 'settings'].forEach(page => {
      const sec = $(`#page-${page}`);
      sec.querySelector('.sv-only').classList.toggle('hidden', !s);
      const empty = sec.querySelector('[data-empty]');
      empty.classList.toggle('hidden', Boolean(s));
      if (!s) {
        const none = S.serversLoaded && S.servers.length === 0;
        empty.innerHTML = `<div class="empty-icon">${icon('server')}</div><h2>${none ? 'Belum ada server' : 'Belum ada server dipilih'}</h2><p>${none ? 'Buat server terlebih dahulu di Daftar Server.' : `Pilih server di Daftar Server untuk membuka ${TITLES[page]}.`}</p><a class="btn btn-primary" href="#/servers">Ke Daftar Server</a>`;
      }
    });
  }

  /* ----------------------------------------------------------- console */
  const con = { lastSeq: 0, autoScroll: true, history: [], hIdx: 0 };
  const term = () => $('#consoleOutput');

  function lineEl(entry) {
    const d = document.createElement('div');
    d.className = `ln ln-${entry.type}`;
    const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = P.formatTime(entry.t);
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = entry.text;
    d.append(ts, tx);
    return d;
  }
  function scrollEnd() { if (con.autoScroll) { const el = term(); el.scrollTop = el.scrollHeight; } }
  function appendEntries(entries) {
    const el = term();
    const frag = document.createDocumentFragment();
    for (const e of entries) { if (e.seq > con.lastSeq) { frag.appendChild(lineEl(e)); con.lastSeq = e.seq; } }
    el.appendChild(frag);
    while (el.children.length > 1000) el.removeChild(el.firstChild);
    scrollEnd();
  }
  function resetConsole() {
    con.lastSeq = 0;
    const el = term();
    if (el) { el.innerHTML = ''; }
  }
  function joinConsole() {
    if (S.selectedId && socket && socket.connected) socket.emit('join-server', S.selectedId);
    else if (S.selectedId) pollLogs();
  }
  async function pollLogs() {
    const id = S.selectedId;
    if (!id) return;
    try {
      const r = await api(`/api/servers/${id}/logs?after=${con.lastSeq}`);
      if (id !== S.selectedId) return;
      appendEntries(r.entries);
    } catch {}
  }

  function renderConsoleState() {
    const s = P.selected();
    const running = Boolean(s && s.status === 'running');
    $('#startBtn').disabled = !s || running;
    $('#restartBtn').disabled = !s || !running;
    $('#stopBtn').disabled = !s || !running;
    const input = $('#commandInput');
    input.disabled = !running;
    $('#sendBtn').disabled = !running;
    input.placeholder = running ? 'Kirim input ke proses server... (Enter)' : 'Server offline. Tekan Start untuk menjalankan.';
    $('#termTitle').textContent = s ? `${s.id} — npm start` : 'console';
    tickMeta();
  }
  function tickMeta() {
    const s = P.selected();
    $('#termMeta').textContent = s && s.status === 'running' && s.startedAt ? `PID ${s.pid} · ${P.formatDuration(Date.now() - s.startedAt)}` : (s && s.lastExit ? `berhenti · kode ${s.lastExit.code ?? '-'}` : 'offline');
  }

  async function serverAction(action) {
    const s = P.selected();
    if (!s) return;
    const id = s.id;
    const btns = ['#startBtn', '#restartBtn', '#stopBtn'].map(sel => $(sel));
    btns.forEach(b => { b.disabled = true; });
    try {
      await api(`/api/servers/${id}/${action}`, { method: 'POST', body: {} });
      if (action !== 'stop') P.ok(action === 'start' ? 'Server dijalankan.' : 'Server di-restart.');
    } catch (e) { P.fail(e); }
    await loadServers({ quiet: true });
    if (id === S.selectedId && !socket?.connected) pollLogs();
  }
  $('#startBtn').onclick = () => serverAction('start');
  $('#restartBtn').onclick = () => serverAction('restart');
  $('#stopBtn').onclick = () => serverAction('stop');

  $('#autoScrollBtn').onclick = () => {
    con.autoScroll = !con.autoScroll;
    const b = $('#autoScrollBtn');
    b.classList.toggle('on', con.autoScroll); b.setAttribute('aria-pressed', String(con.autoScroll));
    scrollEnd();
  };
  term().addEventListener('scroll', () => {
    const el = term();
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atEnd && con.autoScroll) { con.autoScroll = false; $('#autoScrollBtn').classList.remove('on'); $('#autoScrollBtn').setAttribute('aria-pressed', 'false'); }
  });
  $('#clearLogBtn').onclick = async () => {
    const id = S.selectedId;
    term().innerHTML = '';
    if (!id) return;
    try { await api(`/api/servers/${id}/logs`, { method: 'DELETE' }); } catch (e) { P.fail(e); }
  };
  $('#commandForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = S.selectedId;
    const input = $('#commandInput');
    const command = input.value;
    if (!id || !command.trim()) return;
    try {
      await api(`/api/servers/${id}/command`, { method: 'POST', body: { command } });
      con.history.push(command); con.hIdx = con.history.length;
      input.value = '';
      if (!socket?.connected) pollLogs();
    } catch (err) { P.fail(err); loadServers({ quiet: true }); }
  });
  $('#commandInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && con.history.length) { e.preventDefault(); con.hIdx = Math.max(0, con.hIdx - 1); e.target.value = con.history[con.hIdx] || ''; }
    if (e.key === 'ArrowDown' && con.history.length) { e.preventDefault(); con.hIdx = Math.min(con.history.length, con.hIdx + 1); e.target.value = con.history[con.hIdx] || ''; }
  });

  /* ------------------------------------------------------------ socket */
  function connectSocket() {
    if (socket || typeof io !== 'function') return;
    socket = io();
    socket.on('connect', () => { joinConsole(); });
    socket.on('log-history', p => {
      if (p.id !== S.selectedId) return;
      term().innerHTML = ''; con.lastSeq = 0;
      appendEntries(p.entries);
      con.lastSeq = Math.max(con.lastSeq, p.lastSeq || 0);
    });
    socket.on('log', p => { if (p.id === S.selectedId) appendEntries([p.entry]); });
    socket.on('log-clear', p => { if (p.id === S.selectedId) term().innerHTML = ''; });
    socket.on('server-status', p => {
      const s = byId(p.id);
      if (!s) return loadServers({ quiet: true });
      Object.assign(s, { status: p.status, pid: p.pid, startedAt: p.startedAt, lastExit: p.lastExit });
      renderAll();
    });
    socket.on('servers-changed', () => loadServers({ quiet: true }));
    socket.on('connect_error', () => { /* polling fallback mengambil alih */ });
  }
  function disconnectSocket() { if (socket) { socket.disconnect(); socket = null; } }

  /* ---------------------------------------------------------- settings */
  function renderSettings() {
    const s = P.selected();
    if (!s) return;
    const rows = [
      ['Nama', esc(s.name)], ['ID', `<span class="mono">${esc(s.id)}</span>`, 'mono'], ['Folder data', `<span class="mono">${esc(s.directory)}</span>`, 'mono'],
      ['Status', statusChip(s.status)], ['Dibuat', P.formatDate(Date.parse(s.createdAt))],
      ['Proses', s.status === 'running' ? `PID ${s.pid}${s.startedAt ? ` · aktif ${P.formatDuration(Date.now() - s.startedAt)}` : ''}` : (s.lastExit ? `Terakhir berhenti dengan kode ${s.lastExit.code ?? '-'}` : 'Belum pernah dijalankan')]
    ];
    $('#infoList').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    const input = $('#renameInput');
    if (document.activeElement !== input && input.dataset.for !== s.id + s.name) { input.value = s.name; input.dataset.for = s.id + s.name; }
    const running = s.status === 'running';
    $('#deleteBtn').disabled = running;
    $('#deleteHint').classList.toggle('hidden', !running);
    $('#deleteHint').textContent = 'Server sedang berjalan. Stop dulu dari halaman Console sebelum menghapus.';
  }

  $('#renameForm').addEventListener('submit', async e => {
    e.preventDefault();
    const s = P.selected();
    if (!s) return;
    const name = $('#renameInput').value.trim();
    $('#renameError').textContent = '';
    if (name === s.name) { $('#renameError').textContent = 'Nama sama dengan sebelumnya.'; return; }
    try {
      await api(`/api/servers/${s.id}`, { method: 'PATCH', body: { name } });
      await loadServers();
      P.ok(`Nama diubah menjadi "${name}".`);
    } catch (err) { $('#renameError').textContent = err.message; }
  });

  $('#deleteBtn').onclick = async () => {
    const s = P.selected();
    if (!s) return;
    const v = await P.dialog({
      title: `Hapus server "${s.name}"?`,
      message: 'Pilih apa yang ingin dihapus. Tindakan ini tidak bisa dibatalkan.',
      confirmText: 'Hapus', danger: true,
      fields: [
        { name: 'mode', type: 'radio', value: 'config', options: [
          { value: 'config', label: 'Hapus konfigurasi saja', hint: `Server hilang dari panel. Folder ${s.directory} dan semua filenya TETAP ADA, dan bisa ditambahkan lagi nanti.` },
          { value: 'data', label: 'Hapus konfigurasi + seluruh data', hint: `Folder ${s.directory} beserta semua file di dalamnya dihapus PERMANEN.`, danger: true }
        ] },
        { name: 'confirm', label: `Ketik "${s.id}" untuk mengonfirmasi penghapusan data`, placeholder: s.id, showIf: v => v.mode === 'data' }
      ],
      disableUntil: v => v.mode === 'config' || v.confirm.trim() === s.id
    });
    if (!v) return;
    try {
      const q = v.mode === 'data' ? `?deleteData=1&confirm=${encodeURIComponent(s.id)}` : '';
      const r = await api(`/api/servers/${s.id}${q}`, { method: 'DELETE' });
      setSelected(null, true);
      await loadServers();
      P.ok(r.dataDeleted ? `Server dan data ${r.directory} dihapus.` : `Konfigurasi dihapus. Folder ${r.directory} masih ada.`);
      location.hash = '#/servers';
    } catch (e) { P.fail(e); }
  };

  /* ------------------------------------------------------------ router */
  function pageFromHash() {
    const h = location.hash.replace(/^#\/?/, '');
    return PAGES.includes(h) ? h : 'servers';
  }
  let ignoreHash = false;
  async function route() {
    if (ignoreHash) { ignoreHash = false; return; }
    const page = pageFromHash();
    if (currentPage === 'files' && page !== 'files' && !(await P.files.canLeave())) {
      ignoreHash = true; location.hash = '#/files'; return;
    }
    currentPage = page;
    $$('.page').forEach(el => { el.hidden = el.dataset.page !== page; });
    $$('.bottom-nav a').forEach(a => {
      const on = a.dataset.nav === page;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${TITLES[page]} · Henkaramazov`;
    window.scrollTo(0, 0);
    if (page === 'servers') loadServers({ quiet: true });
    if (page === 'console') { loadServers({ quiet: true }); if (!socket?.connected) pollLogs(); else if (!con.lastSeq) joinConsole(); }
    if (page === 'files' && S.selectedId) P.files.onShow();
    if (page === 'settings') loadServers({ quiet: true });
  }
  window.addEventListener('hashchange', route);

  /* ------------------------------------------------------- login/logout */
  function startTimers() {
    stopTimers();
    statusTimer = setInterval(() => loadServers({ quiet: true }), 5000);
    tickTimer = setInterval(() => { tickMeta(); if (currentPage === 'servers') renderServers(); }, 1000);
    pollTimer = setInterval(() => { if (currentPage === 'console' && !(socket && socket.connected)) pollLogs(); }, 2000);
  }
  function stopTimers() { clearInterval(statusTimer); clearInterval(tickTimer); clearInterval(pollTimer); }

  async function showApp() {
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    try { Object.assign(S.limits, (await api('/api/info')).limits); } catch {}
    connectSocket();
    await loadServers();
    currentPage = null;
    await route();
    startTimers();
  }
  function showLogin() {
    stopTimers(); disconnectSocket();
    $('#app').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
    $('#password').focus();
  }

  P.on('unauthorized', () => { if (!$('#app').classList.contains('hidden')) { P.toast('Sesi berakhir. Silakan login lagi.', 'err'); showLogin(); } });

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('#loginError').textContent = '';
    const btn = $('#loginBtn'); btn.disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
      $('#password').value = '';
      await showApp();
    } catch (err) { $('#loginError').textContent = err.message; }
    finally { btn.disabled = false; }
  });

  $('#logoutBtn').onclick = async () => {
    if (!(await P.files.canLeave())) return;
    const running = S.servers.filter(s => s.status === 'running').length;
    const ok = await P.confirm({
      title: 'Keluar dari panel?',
      message: `Sesi login akan diakhiri dan kamu kembali ke halaman login.${running ? `\n\n${running} server yang sedang berjalan TIDAK dihentikan dan tetap aktif.` : ''}`,
      confirmText: 'Keluar'
    });
    if (!ok) return;
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    P.files.reset(); resetConsole();
    S.servers = []; S.serversLoaded = false;
    showLogin();
  };

  (async () => {
    try {
      const r = await api('/api/session');
      if (r.authenticated) await showApp(); else showLogin();
    } catch (e) { showLogin(); $('#loginError').textContent = e.message; }
  })();
})();
