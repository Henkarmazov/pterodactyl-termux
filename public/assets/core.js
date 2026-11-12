/* Henkaramazov Panel - core: utilitas bersama (API, ikon, dialog, toast, progres transfer) */
(function () {
  'use strict';

  const P = (window.P = {});
  const listeners = {};

  P.$ = (sel, root) => (root || document).querySelector(sel);
  P.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  P.on = (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); };
  P.emit = (evt, ...args) => (listeners[evt] || []).forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });

  P.esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ----------------------------------------------------------- state */
  P.state = {
    servers: [],
    serversLoaded: false,
    selectedId: null,
    limits: { maxUploadBytes: 200 * 1048576, maxExtractBytes: 1024 * 1048576 }
  };
  try { P.state.selectedId = localStorage.getItem('henka.selected') || null; } catch {}
  P.selected = () => P.state.servers.find(s => s.id === P.state.selectedId) || null;

  /* ----------------------------------------------------------- icons */
  const ICONS = {
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
    sliders: '<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M7 4.5v15l13-7.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
    upload: '<path d="M12 16V5"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v6M9 15h6"/>',
    code: '<path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/><path d="M13.5 6l-3 12"/>',
    more: '<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
    arrowDown: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
    save: '<path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7V3"/><path d="M8 21v-7h8v7"/>',
    eraser: '<path d="M3 17l8-8 6 6-5 5H7z"/><path d="M14 20h7"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    swap: '<path d="M7 7h12l-3-3"/><path d="M17 17H5l3 3"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>'
  };
  P.icon = (name, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  P.hydrateIcons = root => P.$$('[data-icon]', root).forEach(el => { if (!el.dataset.done) { el.innerHTML = P.icon(el.dataset.icon); el.dataset.done = '1'; } });

  /* ----------------------------------------------------------- format */
  P.formatSize = n => {
    if (n == null) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const p2 = n => String(n).padStart(2, '0');
  P.formatDate = ms => {
    if (!ms) return '-';
    const d = new Date(ms);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  P.formatTime = ms => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  P.formatDuration = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}h ${h}j`;
    if (h) return `${h}j ${m}m`;
    if (m) return `${m}m ${s % 60}d`;
    return `${s}d`;
  };

  /* -------------------------------------------------------------- api */
  P.api = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin', ...options, headers, body });
    } catch {
      throw Object.assign(new Error('Tidak bisa terhubung ke panel. Periksa apakah server panel masih berjalan.'), { network: true });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.error || `Permintaan gagal (${response.status})`);
      Object.assign(err, { status: response.status, code: data.code, data });
      if (response.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/session')) P.emit('unauthorized');
      throw err;
    }
    return data;
  };

  /* ------------------------------------------------------------ toast */
  P.toast = (message, kind) => {
    const box = P.$('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    el.textContent = message;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3200);
  };
  P.ok = m => P.toast(m, 'ok');
  P.fail = e => P.toast(e && e.message ? e.message : String(e), 'err');

  /* ----------------------------------------------------------- dialog */
  let dialogOpen = false;
  function mountOverlay(inner) {
    const root = P.$('#dialogRoot');
    root.innerHTML = '';
    root.appendChild(inner);
    root.classList.remove('hidden');
    P.hydrateIcons(root);
    dialogOpen = true;
  }
  function closeOverlay() {
    const root = P.$('#dialogRoot');
    root.classList.add('hidden');
    root.innerHTML = '';
    root.onclick = null;
    dialogOpen = false;
  }
  P.isDialogOpen = () => dialogOpen;

  /**
   * opts: { title, message, items[], fields[], confirmText, cancelText, danger, validate(values) }
   * fields: { name, type: 'text'|'radio'|'checkbox', label, value, placeholder, options:[{value,label,hint,danger}] , hidden(values) }
   * Resolve: object nilai field (atau {}), atau null jika dibatalkan.
   */
  P.dialog = opts => new Promise(resolve => {
    const form = document.createElement('form');
    form.className = 'dialog';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    let html = `<h2>${P.esc(opts.title || '')}</h2>`;
    if (opts.message) html += `<p class="msg">${P.esc(opts.message)}</p>`;
    if (opts.items && opts.items.length) {
      const shown = opts.items.slice(0, 50);
      html += `<ul class="list">${shown.map(i => `<li>${P.esc(i)}</li>`).join('')}${opts.items.length > shown.length ? `<li>... dan ${opts.items.length - shown.length} lainnya</li>` : ''}</ul>`;
    }
    (opts.fields || []).forEach((f, i) => {
      if (f.type === 'radio') {
        html += `<div class="field" data-field="${P.esc(f.name)}">${f.options.map((o, k) => `<label class="opt ${o.danger ? 'danger' : ''}"><input type="radio" name="${P.esc(f.name)}" value="${P.esc(o.value)}" ${(f.value === undefined ? k === 0 : f.value === o.value) ? 'checked' : ''}><span><b>${P.esc(o.label)}</b>${o.hint ? `<small>${P.esc(o.hint)}</small>` : ''}</span></label>`).join('')}</div>`;
      } else if (f.type === 'checkbox') {
        html += `<div class="field" data-field="${P.esc(f.name)}"><label class="opt"><input type="checkbox" name="${P.esc(f.name)}" ${f.value ? 'checked' : ''}><span><b>${P.esc(f.label)}</b></span></label></div>`;
      } else {
        html += `<div class="field" data-field="${P.esc(f.name)}"><label for="dlg-${i}">${P.esc(f.label || '')}</label><input id="dlg-${i}" type="text" name="${P.esc(f.name)}" value="${P.esc(f.value || '')}" placeholder="${P.esc(f.placeholder || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>`;
      }
    });
    html += `<p class="dlg-error" role="alert"></p><div class="actions">${opts.cancelText === false ? '' : `<button type="button" class="btn btn-ghost" data-cancel>${P.esc(opts.cancelText || 'Batal')}</button>`}<button type="submit" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-ok>${P.esc(opts.confirmText || 'OK')}</button></div>`;
    form.innerHTML = html;

    const read = () => {
      const values = {};
      (opts.fields || []).forEach(f => {
        if (f.type === 'radio') { const c = form.querySelector(`input[name="${f.name}"]:checked`); values[f.name] = c ? c.value : null; }
        else if (f.type === 'checkbox') values[f.name] = form.querySelector(`input[name="${f.name}"]`).checked;
        else values[f.name] = form.querySelector(`input[name="${f.name}"]`).value;
      });
      return values;
    };
    const refresh = () => {
      const values = read();
      (opts.fields || []).forEach(f => { if (f.showIf) form.querySelector(`[data-field="${f.name}"]`).classList.toggle('hidden', !f.showIf(values)); });
      const ok = form.querySelector('[data-ok]');
      ok.disabled = Boolean(opts.disableUntil && !opts.disableUntil(values));
    };
    const done = value => { document.removeEventListener('keydown', onKey, true); closeOverlay(); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };

    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = read();
      const err = opts.validate ? opts.validate(values) : '';
      if (err) { form.querySelector('.dlg-error').textContent = err; return; }
      done(values);
    });
    const cancel = form.querySelector('[data-cancel]');
    if (cancel) cancel.onclick = () => done(null);
    document.addEventListener('keydown', onKey, true);
    mountOverlay(form);
    P.$('#dialogRoot').onclick = e => { if (e.target.id === 'dialogRoot') done(null); };
    refresh();
    const first = form.querySelector('input[type=text]');
    if (first) { first.focus(); first.select(); } else form.querySelector('[data-ok]').focus();
  });

  P.confirm = opts => P.dialog({ confirmText: 'Ya, lanjutkan', ...opts }).then(v => v !== null);
  P.prompt = opts => P.dialog({
    title: opts.title, message: opts.message, confirmText: opts.confirmText || 'Simpan',
    fields: [{ name: 'value', label: opts.label, value: opts.value, placeholder: opts.placeholder }],
    validate: v => (opts.validate ? opts.validate(v.value.trim()) : (v.value.trim() ? '' : 'Tidak boleh kosong.'))
  }).then(v => (v ? v.value.trim() : null));

  /** Menu aksi (bottom sheet). actions: [{ label, icon, danger, run }] */
  P.sheet = (title, actions) => new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'dialog sheet';
    box.innerHTML = `<div class="sheet-title">${P.esc(title)}</div>` + actions.map((a, i) => `<button type="button" class="sheet-item ${a.danger ? 'danger' : ''}" data-i="${i}">${P.icon(a.icon || 'file')}<span>${P.esc(a.label)}</span></button>`).join('');
    const done = idx => { document.removeEventListener('keydown', onKey, true); closeOverlay(); resolve(); if (idx != null) actions[idx].run(); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    box.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) done(Number(b.dataset.i)); });
    document.addEventListener('keydown', onKey, true);
    mountOverlay(box);
    P.$('#dialogRoot').onclick = e => { if (e.target.id === 'dialogRoot') done(null); };
  });

  /* --------------------------------------------------------- transfer */
  /** Panel progres untuk upload/download/ZIP/ekstraksi. */
  P.transfer = (label, { indeterminate = false } = {}) => {
    const el = document.createElement('div');
    el.className = `transfer ${indeterminate ? 'indet' : ''}`;
    el.innerHTML = '<div class="tr-top"><span></span><span>0%</span></div><div class="tr-bar"><i></i></div><div class="tr-msg hidden"></div><div class="tr-action"></div>';
    P.$('.tr-top span', el).textContent = label;
    P.$('#transfers').appendChild(el);
    const pct = P.$('.tr-top span:last-child', el);
    const bar = P.$('.tr-bar i', el);
    const msg = P.$('.tr-msg', el);
    let removeTimer = null;
    const api = {
      update(fraction, text) {
        el.classList.remove('indet');
        const v = Math.max(0, Math.min(1, fraction));
        bar.style.width = `${(v * 100).toFixed(1)}%`;
        pct.textContent = text || `${Math.round(v * 100)}%`;
      },
      text(t) { msg.textContent = t; msg.classList.toggle('hidden', !t); },
      done(text, action) {
        el.classList.remove('indet'); bar.style.width = '100%'; pct.textContent = 'Selesai';
        if (text) api.text(text);
        if (action) {
          const b = document.createElement('button');
          b.className = 'btn btn-ghost btn-xs'; b.type = 'button'; b.textContent = action.label;
          b.onclick = () => { action.run(); api.close(); };
          P.$('.tr-action', el).appendChild(b);
        }
        removeTimer = setTimeout(api.close, action ? 12000 : 3500);
      },
      fail(text) {
        el.classList.remove('indet'); el.classList.add('fail'); pct.textContent = 'Gagal'; api.text(text);
        removeTimer = setTimeout(api.close, 9000);
      },
      close() { clearTimeout(removeTimer); el.remove(); }
    };
    el.addEventListener('click', e => { if (e.target === el || e.target.classList.contains('tr-top')) { if (el.classList.contains('fail') || pct.textContent === 'Selesai') api.close(); } });
    return api;
  };

  /* ------------------------------------------------------------- logo */
  P.initLogos = () => {
    P.$$('.logo-box').forEach(box => {
      const img = P.$('.logo-img', box);
      if (!img) return;
      const ok = () => box.classList.add('has-img');
      const bad = () => box.classList.remove('has-img');
      img.addEventListener('load', ok);
      img.addEventListener('error', bad);
      if (img.complete) (img.naturalWidth > 0 ? ok : bad)();
    });
  };

  document.addEventListener('DOMContentLoaded', () => { P.hydrateIcons(); P.initLogos(); });
})();
