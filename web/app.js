// SIMERU - frontend statis (GitHub Pages) + Supabase.
(function () {
  'use strict';

  var cfg = Object.assign({
    APP_TITLE: 'SIMERU DTSL', TIMEZONE: 'Asia/Jakarta', TZ_OFFSET: '+07:00', ALLOW_SIGNUP: false, FEED_URL: ''
  }, window.SIMERU_CONFIG || {});
  var L = window.SimeruLib;
  var OFF = cfg.TZ_OFFSET;
  var ROW_H = 22;                      // harus sama dengan tinggi baris di style.css (.tslot / .col)

  var $ = function (id) { return document.getElementById(id); };
  document.title = cfg.APP_TITLE + ' - Jadwal Ruangan';
  $('title').textContent = cfg.APP_TITLE;

  // Pembuat elemen DOM. Semua teks dimasukkan sebagai text node (aman dari XSS).
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) { return; }
        if (k === 'class') { el.className = v; }
        else if (k === 'style' && typeof v === 'object') { Object.assign(el.style, v); }
        else if (k.indexOf('on') === 0 && typeof v === 'function') { el.addEventListener(k.slice(2), v); }
        else if (v === true) { el.setAttribute(k, ''); }
        else { el.setAttribute(k, v); }
      });
    }
    for (var i = 2; i < arguments.length; i++) { appendKid(el, arguments[i]); }
    return el;
  }
  function appendKid(el, kid) {
    if (kid === null || kid === undefined || kid === false) { return; }
    if (Array.isArray(kid)) { kid.forEach(function (k) { appendKid(el, k); }); return; }
    el.appendChild(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) {
    $('main').replaceChildren(h('div', { class: 'notice' },
      'Konfigurasi belum lengkap. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di web/config.js ' +
      '(dan pastikan koneksi internet tersedia untuk memuat pustaka Supabase).'));
    return;
  }
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // ------------------------------------------------------------------ state
  var S = {
    session: null, profile: null,
    areas: [], rooms: [],
    areaId: null,                       // 0 = semua area (hanya tampilan daftar)
    date: L.todayStr(OFF),
    view: 'day',                        // 'day' | 'list'
    entries: [],
    q: '',                              // kata kunci pencarian
    searchAll: false,                   // pencarian: termasuk acara yang sudah lewat
    live: false
  };
  var loadToken = 0;
  var nowCtx = null;

  function showMsg(text, ok) {
    var m = $('msg');
    if (!text) { m.hidden = true; return; }
    m.textContent = text;
    m.className = 'msg' + (ok ? ' ok' : '');
    m.hidden = false;
    if (ok) { setTimeout(function () { if (m.textContent === text) { m.hidden = true; } }, 5000); }
  }

  // Menyembunyikan pesan ERROR saja; pesan sukses (hijau) dibiarkan sampai hilang sendiri
  function clearErr() {
    var m = $('msg');
    if (m.className.indexOf('ok') < 0) { m.hidden = true; }
  }

  function errText(err) {
    if (!err) { return 'Terjadi kesalahan.'; }
    if (err.code === '23P01') { return 'Bentrok: ruangan sudah dipakai pada jam tersebut.'; }
    if (err.code === '42501') { return 'Anda tidak punya izin untuk tindakan ini.'; }
    if (err.code === '23514') { return 'Data tidak memenuhi batasan database (periksa jam dan ukuran slot).'; }
    if (err.code === '23503') { return 'Data masih dipakai oleh data lain.'; }
    return err.message || String(err);
  }

  // ------------------------------------------------------------------ URL hash
  var VIEWS = ['day', 'list', 'rooms', 'report', 'search', 'users', 'admin'];

  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    var d = p.get('date');
    if (d && L.parseDate(d)) { S.date = d; }
    var a = parseInt(p.get('area'), 10);
    if (a >= 0) { S.areaId = a; }
    var v = p.get('view');
    if (VIEWS.indexOf(v) >= 0) { S.view = v; }
    if (p.has('q')) { S.q = p.get('q'); }
  }
  function writeHash() {
    history.replaceState(null, '', hashFor({ q: S.view === 'search' ? S.q : '' }));
  }

  // Alamat hash untuk suatu tampilan (dipakai tautan menu atas dan kalender mini)
  function hashFor(over) {
    var v = Object.assign({ view: S.view, date: S.date, area: S.areaId, q: '' }, over);
    var p = new URLSearchParams();
    p.set('view', v.view);
    p.set('date', v.date);
    if (v.area !== null && v.area !== undefined) { p.set('area', v.area); }
    if (v.q) { p.set('q', v.q); }
    return '#' + p.toString();
  }

  // ------------------------------------------------------------------ data
  function currentArea() {
    return S.areas.filter(function (a) { return a.id === S.areaId; })[0] || null;
  }
  function roomById(id) {
    return S.rooms.filter(function (r) { return r.id === id; })[0] || null;
  }
  function areaOfRoom(roomId) {
    var r = roomById(roomId);
    return r ? S.areas.filter(function (a) { return a.id === r.area_id; })[0] || null : null;
  }
  function normalize() {
    if ((S.view === 'admin' || S.view === 'users') && !isAdmin()) { S.view = 'day'; }
    var valid = S.areas.some(function (a) { return a.id === S.areaId; });
    if (S.view === 'day' && !valid) { S.areaId = S.areas.length ? S.areas[0].id : null; }
    if (S.view === 'list' && !valid && S.areaId !== 0) { S.areaId = 0; }
  }

  async function loadStatic() {
    var a = await sb.from('areas').select('*').eq('disabled', false).order('sort_order').order('name');
    var r = await sb.from('rooms').select('*').eq('disabled', false).order('sort_order').order('name');
    if (a.error || r.error) { throw (a.error || r.error); }
    S.areas = a.data; S.rooms = r.data;
    normalize();
  }

  async function loadEntries() {
    if (PAGE_VIEWS[S.view]) { PAGE_VIEWS[S.view](); return; }
    var token = ++loadToken;
    var from = L.toIso(S.date, '00:00', OFF);
    var to = L.toIso(L.addDays(S.date, 1), '00:00', OFF);
    var q;
    if (S.view === 'day') {
      var area = currentArea();
      var ids = S.rooms.filter(function (r) { return area && r.area_id === area.id; }).map(function (r) { return r.id; });
      if (!ids.length) { S.entries = []; renderMain(); return; }
      q = sb.from('entries').select('*').in('room_id', ids);
    } else {
      q = sb.from('events').select('*');
      if (S.areaId) { q = q.eq('area_id', S.areaId); }
    }
    var res = await q.lt('start_time', to).gt('end_time', from).order('start_time');
    if (token !== loadToken) { return; }      // ada permintaan yang lebih baru
    if (res.error) { showMsg('Gagal memuat jadwal: ' + errText(res.error)); return; }
    clearErr();
    S.entries = res.data;
    renderMain();
  }

  async function loadProfile() {
    if (!S.session) { S.profile = null; return; }
    var res = await sb.from('profiles').select('display_name, role').eq('id', S.session.user.id).maybeSingle();
    S.profile = res.data || null;
  }

  function isAdmin() { return !!(S.profile && S.profile.role === 'admin'); }
  function canEdit(e) {
    return !!(S.session && (isAdmin() || e.created_by === S.session.user.id));
  }

  // ------------------------------------------------------------------ navigasi
  function go(patch) {
    Object.assign(S, patch);
    normalize();
    writeHash();
    renderToolbar();
    loadEntries();
  }

  // ------------------------------------------------------------------ header & toolbar
  function renderHeader() {
    var box = $('userbox');
    var kids = [];
    if (S.session) {
      var name = (S.profile && S.profile.display_name) || S.session.user.email;
      kids.push(h('div', { class: 'uname' }, name + (isAdmin() ? ' (admin)' : '')),
        h('button', { onclick: function () { sb.auth.signOut(); } }, 'Keluar'),
        h('button', { class: 'linkbtn', onclick: openChangePassword }, 'Ganti password'));
    } else {
      kids.push(h('div', { class: 'uname' }, 'Belum masuk'),
        h('button', { onclick: function () { openLogin(); } }, 'Masuk'));
    }
    box.replaceChildren.apply(box, kids);
  }

  function renderToolbar() {
    var tb = $('toolbar');
    renderNav();
    renderMiniCal();
    if (PAGE_TITLES[S.view]) {
      var tkids = [h('button', { onclick: function () { go({ view: 'day' }); } }, '\u2039 Kembali ke jadwal'),
        h('strong', null, PAGE_TITLES[S.view]),
        h('span', { class: 'spacer' })];
      if (S.view === 'admin') { tkids.push(h('button', { class: 'primary', onclick: function () { openAreaForm(null); } }, '+ Tambah area')); }
      if (S.view === 'users') { tkids.push(h('button', { class: 'primary', onclick: function () { openUserForm(null); } }, '+ Tambah pengguna')); }
      tb.replaceChildren.apply(tb, tkids);
      return;
    }
    var areaSel = h('select', { 'aria-label': 'Area', onchange: function (e) { go({ areaId: parseInt(e.target.value, 10) }); } },
      S.view === 'list' ? h('option', { value: 0, selected: S.areaId === 0 }, 'Semua area') : null,
      S.areas.map(function (a) { return h('option', { value: a.id, selected: a.id === S.areaId }, a.name); }));
    var dateInput = h('input', { type: 'date', value: S.date, 'aria-label': 'Tanggal',
      onchange: function (e) { if (L.parseDate(e.target.value)) { go({ date: e.target.value }); } } });
    tb.replaceChildren(
      h('button', { onclick: function () { go({ date: L.addDays(S.date, -1) }); } }, '\u2039 Kemarin'),
      h('button', { onclick: function () { go({ date: L.todayStr(OFF) }); } }, 'Hari ini'),
      h('button', { onclick: function () { go({ date: L.addDays(S.date, 1) }); } }, 'Besok \u203A'),
      dateInput, areaSel,
      h('span', { class: 'seg' },
        h('button', { class: S.view === 'day' ? 'on' : '', onclick: function () { go({ view: 'day' }); } }, 'Grid'),
        h('button', { class: S.view === 'list' ? 'on' : '', onclick: function () { go({ view: 'list' }); } }, 'Daftar')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'live' + (S.live ? ' on' : ''), id: 'live', title: 'Update otomatis (realtime)' },
        h('i'), S.live ? 'Live' : 'Offline'),
      h('button', { class: 'primary', onclick: function () { openForm({}); } }, '+ Tambah jadwal'));
  }

  function setLive(on) {
    S.live = on;
    var el = $('live');
    if (el) { el.className = 'live' + (on ? ' on' : ''); el.lastChild.textContent = on ? 'Live' : 'Offline'; }
  }

  function renderMain() {
    if (S.view === 'list') { renderList(); } else { renderDay(); }
  }

  // ------------------------------------------------------------------ tampilan grid
  function renderDay() {
    var main = $('main');
    nowCtx = null;
    var area = currentArea();
    if (!area) {
      main.replaceChildren(h('div', { class: 'notice' },
        isAdmin()
          ? [h('p', null, 'Belum ada area. Tambahkan area dan ruangan lebih dulu.'),
             h('button', { class: 'primary', onclick: function () { go({ view: 'admin' }); } }, '\u2699 Kelola Area & Ruang')]
          : 'Belum ada area/ruangan. Hubungi admin untuk menambahkannya.'));
      return;
    }
    var rooms = S.rooms.filter(function (r) { return r.area_id === area.id; });
    if (!rooms.length) {
      main.replaceChildren(h('div', { class: 'notice' },
        isAdmin()
          ? [h('p', null, 'Area ini belum punya ruangan.'),
             h('button', { class: 'primary', onclick: function () { go({ view: 'admin' }); } }, '\u2699 Kelola Area & Ruang')]
          : 'Area ini belum punya ruangan. Hubungi admin untuk menambahkannya.'));
      return;
    }
    var slotMin = area.slot_minutes;
    var nSlots = L.slotCount(area);
    var ppm = ROW_H / slotMin;
    var day0 = L.dayStartMs(S.date, OFF);
    var gridStart = day0 + area.start_hour * 3600000;
    var gridEnd = day0 + area.end_hour * 3600000;
    var bodyH = nSlots * ROW_H;

    var times = h('div', { class: 'times', style: { height: bodyH + 'px' } });
    for (var i = 0; i < nSlots; i++) {
      times.appendChild(h('div', { class: 'tslot' }, L.minutesToTime(area.start_hour * 60 + i * slotMin)));
    }

    var cols = rooms.map(function (room) {
      var col = h('div', { class: 'col', style: { height: bodyH + 'px' },
        onclick: function (ev) {
          var y = ev.clientY - col.getBoundingClientRect().top;
          var min = L.minutesFromOffset(y, ROW_H, area);
          openForm({ roomId: room.id, startMs: day0 + min * 60000 });
        } });
      S.entries.filter(function (e) { return e.room_id === room.id; }).forEach(function (e) {
        var lay = L.layout(Date.parse(e.start_time), Date.parse(e.end_time), gridStart, gridEnd, ppm);
        if (!lay) { return; }
        var bg = L.entryColor(e);
        col.appendChild(h('div', {
          class: 'entry' + (e.tentative ? ' tentative' : ''),
          style: { top: Math.round(lay.top) + 'px', height: Math.max(Math.round(lay.height) - 1, 12) + 'px', backgroundColor: bg, color: L.contrastText(bg) },
          title: e.name,
          onclick: function (ev) { ev.stopPropagation(); openDetail(e); }
        }, h('div', { class: 'etitle' }, e.name),
           h('div', { class: 'etime' }, L.msToTime(Date.parse(e.start_time), OFF) + '-' + L.msToTime(Date.parse(e.end_time), OFF) +
             (e.created_by_name ? ' \u2022 ' + e.created_by_name : ''))));
      });
      col.appendChild(h('div', { class: 'nowline', hidden: true }));
      return col;
    });

    var grid = h('div', { class: 'dgrid', style: { gridTemplateColumns: '60px repeat(' + rooms.length + ', minmax(150px, 1fr))' } },
      h('div', { class: 'corner' }, 'Waktu'),
      rooms.map(function (r) { return h('div', { class: 'rhead', title: r.description || '' }, r.name + (r.capacity ? ' (' + r.capacity + ')' : '')); }),
      times, cols);

    main.replaceChildren(h('h2', { class: 'daytitle' }, L.longDate(S.date) + ' \u2013 ' + area.name),
      h('div', { class: 'dwrap' }, grid));

    nowCtx = { root: grid, gridStart: gridStart, gridEnd: gridEnd, ppm: ppm };
    positionNow();
  }

  function positionNow() {
    if (!nowCtx) { return; }
    var now = Date.now();
    var lines = nowCtx.root.querySelectorAll('.nowline');
    var visible = now >= nowCtx.gridStart && now < nowCtx.gridEnd;
    for (var i = 0; i < lines.length; i++) {
      lines[i].hidden = !visible;
      if (visible) { lines[i].style.top = ((now - nowCtx.gridStart) / 60000 * nowCtx.ppm) + 'px'; }
    }
  }
  setInterval(positionNow, 60000);

  // ------------------------------------------------------------------ tampilan daftar
  function renderList() {
    var main = $('main');
    nowCtx = null;
    var day0 = L.dayStartMs(S.date, OFF), day1 = L.dayStartMs(L.addDays(S.date, 1), OFF);
    var rows = S.entries.map(function (e) {
      var s = Math.max(Date.parse(e.start_time), day0), en = Math.min(Date.parse(e.end_time), day1);
      return h('tr', { class: 'row', onclick: function () { openDetail(e); } },
        h('td', { class: 'time' }, L.msToTime(s, OFF) + ' - ' + (en >= day1 ? '24:00' : L.msToTime(en, OFF))),
        h('td', null, h('span', { class: 'dot', style: { backgroundColor: L.entryColor(e) } }), e.name,
          e.tentative ? h('span', { class: 'tag' }, 'Tentatif') : null,
          h('span', { class: 'tag' }, L.TYPE_LABELS[e.type] || e.type),
          e.description ? h('div', { class: 'muted' }, e.description.length > 140 ? e.description.slice(0, 140) + '\u2026' : e.description) : null),
        h('td', null, e.room_name, h('div', { class: 'muted' }, e.area_name)),
        h('td', null, e.created_by_name || ''));
    });
    var parts = [
      h('h2', { class: 'daytitle' }, L.longDate(S.date) + ' \u2013 ' + S.entries.length + ' acara'),
      h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Waktu'), h('th', null, 'Acara'), h('th', null, 'Ruang'), h('th', null, 'Dibuat oleh'))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4 }, 'Tidak ada acara.'))))
    ];
    if (cfg.FEED_URL) {
      var q = '?date=' + S.date + (S.areaId ? '&area=' + S.areaId : '');
      parts.push(h('div', { class: 'feedlinks' }, 'Feed: ',
        h('a', { href: cfg.FEED_URL + q + '&format=rss' }, 'RSS'), ' \u00B7 ',
        h('a', { href: cfg.FEED_URL + q + '&format=json' }, 'JSON')));
    }
    main.replaceChildren.apply(main, parts);
  }

  // ------------------------------------------------------------------ dialog umum
  var dlg = $('dlg');
  function openDialog(content) {
    dlg.replaceChildren(h('div', { class: 'dbody' }, content));
    if (!dlg.open) { dlg.showModal(); }
  }
  function closeDialog() { if (dlg.open) { dlg.close(); } }
  dlg.addEventListener('click', function (ev) { if (ev.target === dlg) { closeDialog(); } });

  // ------------------------------------------------------------------ login
  function openLogin(note) {
    var email = h('input', { type: 'email', autocomplete: 'username', required: true });
    var pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    var nameIn = h('input', { type: 'text', autocomplete: 'name', placeholder: 'Nama tampilan (untuk Daftar)' });
    var err = h('div', { class: 'ferr', hidden: true });
    function fail(t) { err.textContent = t; err.hidden = false; }

    async function submit(signup) {
      err.hidden = true;
      if (!email.value || !pass.value) { fail('Email dan password wajib diisi.'); return; }
      var res = signup
        ? await sb.auth.signUp({ email: email.value.trim(), password: pass.value, options: { data: { display_name: nameIn.value.trim() } } })
        : await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (res.error) { fail(res.error.message); return; }
      if (signup && !res.data.session) { fail('Pendaftaran berhasil. Cek email Anda untuk konfirmasi, lalu masuk.'); return; }
      closeDialog();
    }

    var form = h('form', { onsubmit: function (ev) { ev.preventDefault(); submit(false); } },
      h('h3', null, 'Masuk'),
      note ? h('p', { class: 'muted' }, note) : null,
      err,
      h('div', { class: 'frow' }, h('label', null, 'Email'), email),
      h('div', { class: 'frow' }, h('label', null, 'Password'), pass),
      cfg.ALLOW_SIGNUP ? h('div', { class: 'frow' }, h('label', null, 'Nama'), nameIn) : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: closeDialog }, 'Batal'),
        cfg.ALLOW_SIGNUP ? h('button', { type: 'button', onclick: function () { submit(true); } }, 'Daftar') : null,
        h('button', { type: 'submit', class: 'primary' }, 'Masuk')));
    openDialog(form);
    email.focus();
  }

  // ------------------------------------------------------------------ detail jadwal
  function openDetail(e) {
    var s = Date.parse(e.start_time), en = Date.parse(e.end_time);
    var sd = L.msToDate(s, OFF), ed = L.msToDate(en, OFF);
    var when = sd === ed
      ? L.longDate(sd) + ', ' + L.msToTime(s, OFF) + ' - ' + L.msToTime(en, OFF)
      : L.shortDate(sd) + ' ' + L.msToTime(s, OFF) + ' \u2192 ' + L.shortDate(ed) + ' ' + L.msToTime(en, OFF);
    var room = roomById(e.room_id) || {};
    var area = areaOfRoom(e.room_id) || {};
    var color = L.entryColor(e);
    var actions = [h('button', { onclick: closeDialog }, 'Tutup')];
    if (canEdit(e)) {
      actions.unshift(h('button', { class: 'danger', onclick: function () { openDelete(e); } }, 'Hapus'),
        h('button', { class: 'primary', onclick: function () { openForm({ entry: e }); } }, 'Ubah'));
    }
    openDialog([
      h('h3', null, e.name),
      h('dl', { class: 'dl' },
        h('dt', null, 'Waktu'), h('dd', null, when),
        h('dt', null, 'Ruang'), h('dd', null, (room.name || e.room_name || '') + (area.name ? ' (' + area.name + ')' : '')),
        h('dt', null, 'Deskripsi'), h('dd', null, e.description || '-'),
        h('dt', null, 'Tipe'), h('dd', null, L.TYPE_LABELS[e.type] || e.type),
        h('dt', null, 'Warna'), h('dd', null, h('span', { class: 'dot', style: { backgroundColor: color } }), e.color ? color : 'Bawaan tipe'),
        h('dt', null, 'Status'), h('dd', null, e.tentative ? 'Tentatif' : 'Dikonfirmasi'),
        h('dt', null, 'Dibuat oleh'), h('dd', null, e.created_by_name || '-'),
        e.series_id ? [h('dt', null, 'Berulang'), h('dd', null, 'Bagian dari jadwal berulang')] : null),
      h('div', { class: 'actions' }, actions)
    ]);
  }

  // ------------------------------------------------------------------ hapus
  function openDelete(e) {
    var err = h('div', { class: 'ferr', hidden: true });
    async function doDelete(scope) {
      var q = sb.from('entries').delete();
      q = scope === 'series' ? q.eq('series_id', e.series_id).gte('start_time', e.start_time) : q.eq('id', e.id);
      var res = await q.select('id');
      if (res.error) { err.textContent = errText(res.error); err.hidden = false; return; }
      if (!res.data.length) { err.textContent = 'Tidak ada yang terhapus (tidak punya izin?).'; err.hidden = false; return; }
      closeDialog();
      showMsg(res.data.length + ' jadwal dihapus.', true);
      RPT.result = null;                  // hasil laporan lama sudah tidak akurat
      loadEntries();
    }
    var buttons = [h('button', { onclick: closeDialog }, 'Batal'),
      h('button', { class: 'danger', onclick: function () { doDelete('one'); } }, e.series_id ? 'Hanya jadwal ini' : 'Ya, hapus')];
    if (e.series_id) {
      buttons.push(h('button', { class: 'danger', onclick: function () { doDelete('series'); } }, 'Ini dan seterusnya'));
    }
    openDialog([h('h3', null, 'Hapus jadwal?'),
      h('p', null, e.name + (e.series_id ? ' adalah bagian dari jadwal berulang.' : '')), err,
      h('div', { class: 'actions' }, buttons)]);
  }

  // ------------------------------------------------------------------ form tambah / ubah
  function openForm(opts) {
    if (!S.session) { openLogin('Silakan masuk untuk menambah atau mengubah jadwal.'); return; }
    var editing = !!opts.entry, e = opts.entry;
    var area0 = editing ? (areaOfRoom(e.room_id) || currentArea()) : (currentArea() || S.areas[0]);
    if (!area0) { showMsg('Belum ada area/ruangan.'); return; }

    var startMs = editing ? Date.parse(e.start_time) : (opts.startMs || (L.dayStartMs(S.date, OFF) + area0.start_hour * 3600000));
    var endMs = editing ? Date.parse(e.end_time) : startMs + 3600000;
    var color = editing ? L.sanitizeColor(e.color) : null;

    var name = h('input', { type: 'text', maxlength: 80, required: true, value: editing ? e.name : '' });
    var descr = h('textarea', { rows: 4 }, editing && e.description ? e.description : '');
    var sDate = h('input', { type: 'date', required: true, value: L.msToDate(startMs, OFF) });
    var sTime = h('input', { type: 'time', step: 300, required: true, value: L.msToTime(startMs, OFF) });
    var eDate = h('input', { type: 'date', required: true, value: L.msToDate(endMs, OFF) });
    var eTime = h('input', { type: 'time', step: 300, required: true, value: L.msToTime(endMs, OFF) });
    var allDay = h('input', { type: 'checkbox', id: 'f_allday', onchange: function () {
      var a = areaOf();
      sTime.disabled = eTime.disabled = allDay.checked;
      if (allDay.checked) {
        sTime.value = L.minutesToTime(a.start_hour * 60);
        eTime.value = a.end_hour >= 24 ? '23:59' : L.minutesToTime(a.end_hour * 60);
        eDate.value = sDate.value;
      }
    } });

    var areaSel = h('select', { onchange: function () { fillRooms(); } },
      S.areas.map(function (a) { return h('option', { value: a.id, selected: a.id === area0.id }, a.name); }));
    var roomSel = h('select', editing ? {} : { multiple: true, size: 5 });
    function areaOf() { return S.areas.filter(function (a) { return String(a.id) === areaSel.value; })[0] || area0; }
    function fillRooms() {
      var a = areaOf();
      var wanted = editing ? e.room_id : (opts.roomId || null);
      var list = S.rooms.filter(function (r) { return r.area_id === a.id; });
      var hasWanted = list.some(function (r) { return r.id === wanted; });
      roomSel.replaceChildren.apply(roomSel, list.map(function (r, idx) {
        var sel = hasWanted ? r.id === wanted : idx === 0;      // bila ruangan tidak ada di area ini, pilih yang pertama
        return h('option', { value: r.id, selected: sel }, r.name + (r.capacity ? ' (' + r.capacity + ')' : ''));
      }));
    }
    fillRooms();

    var typeSel = h('select', null, Object.keys(L.TYPE_LABELS).map(function (k) {
      return h('option', { value: k, selected: (editing ? e.type : 'I') === k }, L.TYPE_LABELS[k]);
    }));

    // pemilih warna
    var swatchEls = [];
    var custom = h('input', { type: 'color', class: 'csw', title: 'Warna lain', value: color || '#99cc66',
      oninput: function () { setColor(custom.value); } });
    function setColor(c) {
      color = L.sanitizeColor(c);
      swatchEls.forEach(function (s) { s.el.classList.toggle('sel', s.c === color); });
      var inPalette = swatchEls.some(function (s) { return s.c === color && color !== null; });
      custom.classList.toggle('sel', color !== null && !inPalette);
    }
    function addSwatch(c, label, extra) {
      var el = h('span', { class: 'sw ' + (extra || ''), title: label, style: c ? { backgroundColor: c } : {},
        onclick: function () { setColor(c); if (c) { custom.value = c; } } }, c ? '' : '\u00D7');
      swatchEls.push({ el: el, c: c });
      return el;
    }
    var swBox = h('div', { class: 'swatches' }, addSwatch(null, 'Default (ikut tipe)', 'def'),
      L.PALETTE.map(function (p) { return addSwatch(p[0], p[1]); }), custom);
    setColor(color);

    var conf = h('input', { type: 'radio', name: 'f_status', value: 'c', checked: !(editing && e.tentative) });
    var tent = h('input', { type: 'radio', name: 'f_status', value: 't', checked: !!(editing && e.tentative) });

    // pengulangan (hanya jadwal baru)
    var repRadios = ['none', 'daily', 'weekly', 'monthly', 'yearly'].map(function (v) {
      return h('input', { type: 'radio', name: 'f_rep', value: v, checked: v === 'none', onchange: syncRepeat });
    });
    var repLabels = { none: 'Tidak', daily: 'Harian', weekly: 'Mingguan', monthly: 'Bulanan', yearly: 'Tahunan' };
    var repUntil = h('input', { type: 'date', value: L.msToDate(startMs, OFF), disabled: true });
    var skipConf = h('input', { type: 'checkbox', disabled: true });
    function repValue() { return repRadios.filter(function (r) { return r.checked; })[0].value; }
    function syncRepeat() { var off = repValue() === 'none'; repUntil.disabled = off; skipConf.disabled = off; }

    var err = h('div', { class: 'ferr', hidden: true });
    function fail(t) { err.textContent = t; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); }
    var saveBtn = h('button', { type: 'submit', class: 'primary' }, 'Simpan');

    async function submit(ev) {
      ev.preventDefault();
      err.hidden = true;
      var nm = name.value.trim();
      if (!nm) { fail('Deskripsi singkat wajib diisi.'); return; }
      var startIso = L.toIso(sDate.value, sTime.value, OFF), endIso = L.toIso(eDate.value, eTime.value, OFF);
      if (!(Date.parse(endIso) > Date.parse(startIso))) { fail('Waktu selesai harus setelah waktu mulai.'); return; }
      var roomIds = Array.prototype.filter.call(roomSel.options, function (o) { return o.selected; }).map(function (o) { return parseInt(o.value, 10); });
      if (!roomIds.length) { fail('Pilih minimal satu ruangan.'); return; }
      var tentative = tent.checked;
      saveBtn.disabled = true;
      try {
        if (editing) {
          var upd = await sb.from('entries').update({
            room_id: roomIds[0], start_time: startIso, end_time: endIso, name: nm,
            description: descr.value.trim() || null, type: typeSel.value, color: color, tentative: tentative
          }).eq('id', e.id).select('id');
          if (upd.error) { fail(errText(upd.error)); return; }
          if (!upd.data.length) { fail('Tidak ada yang berubah (tidak punya izin?).'); return; }
          afterSave(sDate.value, roomIds[0], 'Jadwal diperbarui.');
        } else {
          var rep = repValue();
          if (rep !== 'none' && !repUntil.value) { fail('Isi tanggal akhir pengulangan.'); return; }
          var res = await sb.rpc('create_booking', {
            p_room_ids: roomIds, p_start: startIso, p_end: endIso, p_name: nm,
            p_description: descr.value.trim() || null, p_type: typeSel.value, p_color: color,
            p_tentative: tentative, p_repeat: rep, p_repeat_until: rep === 'none' ? null : repUntil.value,
            p_skip_conflicts: skipConf.checked, p_tz: cfg.TIMEZONE
          });
          if (res.error) { fail(errText(res.error)); return; }
          var out = res.data || {};
          if (out.conflicts && out.conflicts.length) { fail(conflictText(out.conflicts, 'Bentrok dengan jadwal lain, belum ada yang disimpan:')); return; }
          var note = out.created + ' jadwal disimpan.';
          if (out.skipped && out.skipped.length) { note += ' ' + out.skipped.length + ' dilewati karena bentrok.'; }
          afterSave(sDate.value, roomIds[0], note);
        }
      } finally {
        saveBtn.disabled = false;
      }
    }

    function afterSave(dateStr, roomId, note) {
      closeDialog();
      var a = areaOfRoom(roomId);
      showMsg(note, true);
      go({ date: dateStr, areaId: a ? a.id : S.areaId, view: S.view === 'list' ? 'list' : 'day' });
    }

    var rows = [
      row('Deskripsi singkat', name),
      row('Deskripsi lengkap', descr),
      row('Mulai', h('div', { class: 'inline' }, sDate, sTime, h('label', null, allDay, ' Seharian'))),
      row('Selesai', h('div', { class: 'inline' }, eDate, eTime)),
      row('Area', areaSel),
      row(editing ? 'Ruangan' : 'Ruangan (Ctrl/Cmd+klik untuk banyak)', roomSel),
      row('Tipe', typeSel),
      row('Warna', swBox),
      row('Status', h('div', { class: 'inline' }, h('label', null, conf, ' Dikonfirmasi'), h('label', null, tent, ' Tentatif')))
    ];
    if (!editing) {
      rows.push(row('Pengulangan', h('div', { class: 'inline' }, repRadios.map(function (r) {
        return h('label', null, r, ' ' + repLabels[r.value]);
      }))));
      rows.push(row('Ulangi sampai', repUntil));
      rows.push(row('Lewati bentrok', h('label', null, skipConf, ' Simpan yang tidak bentrok, lewati sisanya')));
    } else if (e.series_id) {
      rows.push(row('', h('span', { class: 'muted' }, 'Jadwal ini bagian dari seri berulang; perubahan hanya berlaku untuk jadwal ini.')));
    }

    openDialog(h('form', { onsubmit: submit },
      h('h3', null, editing ? 'Ubah Jadwal' : 'Tambah Jadwal'), err, rows,
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: closeDialog }, 'Batal'), saveBtn)));
    name.focus();
  }

  function row(label, control) { return h('div', { class: 'frow' }, h('label', null, label), control); }

  function conflictText(list, head) {
    var lines = list.slice(0, 6).map(function (c) {
      var ms = Date.parse(c.start);
      return '\u2022 ' + c.room + ' pada ' + L.shortDate(L.msToDate(ms, OFF)) + ' ' + L.msToTime(ms, OFF) + ' (bentrok dengan "' + c.with + '")';
    });
    if (list.length > 6) { lines.push('\u2026 dan ' + (list.length - 6) + ' lainnya'); }
    return head + '\n' + lines.join('\n');
  }


  // ------------------------------------------------------------------ menu admin: area & ruang
  var SLOT_CHOICES = [5, 10, 15, 20, 30, 60];
  var adminData = { areas: [], rooms: [] };

  function maxOrder(list) {
    return list.reduce(function (m, x) { return Math.max(m, x.sort_order || 0); }, -1) + 1;
  }

  async function refreshAdmin() {
    try { await loadStatic(); } catch (e) { showMsg('Gagal memuat ulang data: ' + errText(e)); }
    renderAdmin();
  }

  async function renderAdmin() {
    var main = $('main');
    nowCtx = null;
    if (!isAdmin()) {
      main.replaceChildren(h('div', { class: 'notice' }, 'Menu ini hanya untuk admin.'));
      return;
    }
    var token = ++loadToken;
    var a = await sb.from('areas').select('*').order('sort_order').order('name');
    var r = await sb.from('rooms').select('*').order('sort_order').order('name');
    if (token !== loadToken) { return; }
    if (a.error || r.error) { showMsg('Gagal memuat data admin: ' + errText(a.error || r.error)); return; }
    clearErr();
    adminData = { areas: a.data, rooms: r.data };

    var cards = adminData.areas.map(function (area) {
      var myRooms = adminData.rooms.filter(function (x) { return x.area_id === area.id; });
      var nextRoomOrder = maxOrder(myRooms);
      var roomTable = myRooms.length
        ? h('table', { class: 'list' },
            h('thead', null, h('tr', null, h('th', null, 'Ruangan'), h('th', null, 'Kapasitas'),
              h('th', null, 'Keterangan'), h('th', null, 'Urutan'), h('th', null, ''))),
            h('tbody', null, myRooms.map(function (room) {
              return h('tr', { class: room.disabled ? 'off' : '' },
                h('td', null, room.name, room.disabled ? h('span', { class: 'tag' }, 'Nonaktif') : null),
                h('td', null, (room.capacity === null || room.capacity === undefined) ? '-' : room.capacity),
                h('td', null, room.description || ''),
                h('td', null, room.sort_order),
                h('td', null, h('div', { class: 'btns' },
                  h('button', { onclick: function () { openRoomForm(room, area, nextRoomOrder); } }, 'Ubah'),
                  h('button', { onclick: function () { toggleDisabled('rooms', room); } }, room.disabled ? 'Aktifkan' : 'Nonaktifkan'),
                  h('button', { class: 'danger', onclick: function () { openAdminDelete('rooms', room); } }, 'Hapus'))));
            })))
        : h('p', { class: 'muted' }, 'Belum ada ruangan di area ini.');

      return h('section', { class: 'card' + (area.disabled ? ' off' : '') },
        h('div', { class: 'cardhead' },
          h('div', null,
            h('strong', null, area.name), area.disabled ? h('span', { class: 'tag' }, 'Nonaktif') : null,
            h('div', { class: 'muted' }, L.minutesToTime(area.start_hour * 60) + ' - ' + L.minutesToTime(area.end_hour * 60) +
              ' \u2022 slot ' + area.slot_minutes + ' menit \u2022 urutan ' + area.sort_order)),
          h('div', { class: 'btns' },
            h('button', { onclick: function () { openAreaForm(area); } }, 'Ubah area'),
            h('button', { onclick: function () { toggleDisabled('areas', area); } }, area.disabled ? 'Aktifkan' : 'Nonaktifkan'),
            h('button', { class: 'danger', onclick: function () { openAdminDelete('areas', area); } }, 'Hapus area'),
            h('button', { class: 'primary', onclick: function () { openRoomForm(null, area, nextRoomOrder); } }, '+ Tambah ruang'))),
        roomTable);
    });

    var body = [h('p', { class: 'muted' }, 'Area/ruangan yang dinonaktifkan disembunyikan dari tampilan jadwal, tetapi datanya tetap tersimpan. ' +
        'Gunakan Hapus hanya bila benar-benar tidak diperlukan: semua jadwal di dalamnya ikut terhapus permanen.')]
      .concat(cards.length ? cards : [h('div', { class: 'notice' }, 'Belum ada area. Klik "+ Tambah area" di kanan atas.')]);
    main.replaceChildren.apply(main, body);
  }

  async function toggleDisabled(table, row) {
    var res = await sb.from(table).update({ disabled: !row.disabled }).eq('id', row.id).select('id');
    if (res.error) { showMsg('Gagal: ' + errText(res.error)); return; }
    if (!res.data || !res.data.length) { showMsg('Tidak ada yang berubah (tidak punya izin admin?).'); return; }
    showMsg((table === 'areas' ? 'Area ' : 'Ruangan ') + (row.disabled ? 'diaktifkan.' : 'dinonaktifkan.'), true);
    await refreshAdmin();
  }

  function openAreaForm(area) {
    if (!isAdmin()) { return; }
    var editing = !!area;
    var name = h('input', { type: 'text', name: 'name', maxlength: 100, required: true, value: editing ? area.name : '' });
    var order = h('input', { type: 'number', name: 'sort_order', step: 1, value: editing ? area.sort_order : maxOrder(adminData.areas) });
    var sh = h('input', { type: 'number', name: 'start_hour', min: 0, max: 23, step: 1, required: true, value: editing ? area.start_hour : 7 });
    var eh = h('input', { type: 'number', name: 'end_hour', min: 1, max: 24, step: 1, required: true, value: editing ? area.end_hour : 19 });
    var slot = h('select', { name: 'slot_minutes' }, SLOT_CHOICES.map(function (m) {
      return h('option', { value: m, selected: m === (editing ? area.slot_minutes : 30) }, m + ' menit');
    }));
    var err = h('div', { class: 'ferr', hidden: true });
    function fail(t) { err.textContent = t; err.hidden = false; }
    var saveBtn = h('button', { type: 'submit', class: 'primary' }, 'Simpan');

    async function submit(ev) {
      ev.preventDefault();
      err.hidden = true;
      var nm = name.value.trim();
      var s0 = parseInt(sh.value, 10), e0 = parseInt(eh.value, 10), sl = parseInt(slot.value, 10), ord = parseInt(order.value, 10);
      if (!nm) { fail('Nama area wajib diisi.'); return; }
      if (!(s0 >= 0 && s0 <= 23)) { fail('Jam mulai harus antara 0 dan 23.'); return; }
      if (!(e0 >= 1 && e0 <= 24) || e0 <= s0) { fail('Jam selesai harus antara 1 dan 24, dan setelah jam mulai.'); return; }
      if (((e0 - s0) * 60) % sl !== 0) { fail('Rentang jam harus habis dibagi ukuran slot.'); return; }
      var payload = { name: nm, sort_order: isNaN(ord) ? 0 : ord, start_hour: s0, end_hour: e0, slot_minutes: sl };
      saveBtn.disabled = true;
      try {
        var res = editing
          ? await sb.from('areas').update(payload).eq('id', area.id).select('id')
          : await sb.from('areas').insert(payload).select('id');
        if (res.error) { fail(errText(res.error)); return; }
        if (!res.data || !res.data.length) { fail('Tidak ada yang tersimpan (tidak punya izin admin?).'); return; }
        closeDialog();
        showMsg(editing ? 'Area diperbarui.' : 'Area ditambahkan.', true);
        await refreshAdmin();
      } finally {
        saveBtn.disabled = false;
      }
    }

    openDialog(h('form', { onsubmit: submit },
      h('h3', null, editing ? 'Ubah Area' : 'Tambah Area'), err,
      row('Nama area', name),
      row('Jam mulai', h('div', { class: 'inline' }, sh, ' (0\u201323)')),
      row('Jam selesai', h('div', { class: 'inline' }, eh, ' (1\u201324; batas bawah grid)')),
      row('Ukuran slot', slot),
      row('Urutan', order),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: closeDialog }, 'Batal'), saveBtn)));
    name.focus();
  }

  function openRoomForm(room, area, nextOrder) {
    if (!isAdmin()) { return; }
    var editing = !!room;
    var name = h('input', { type: 'text', name: 'name', maxlength: 100, required: true, value: editing ? room.name : '' });
    var cap = h('input', { type: 'number', name: 'capacity', min: 0, step: 1, value: editing && room.capacity != null ? room.capacity : '' });
    var descr = h('input', { type: 'text', name: 'description', maxlength: 200, value: editing && room.description ? room.description : '' });
    var order = h('input', { type: 'number', name: 'sort_order', step: 1, value: editing ? room.sort_order : nextOrder });
    var areaSel = h('select', { name: 'area_id' }, adminData.areas.map(function (a) {
      return h('option', { value: a.id, selected: a.id === area.id }, a.name);
    }));
    var err = h('div', { class: 'ferr', hidden: true });
    function fail(t) { err.textContent = t; err.hidden = false; }
    var saveBtn = h('button', { type: 'submit', class: 'primary' }, 'Simpan');

    async function submit(ev) {
      ev.preventDefault();
      err.hidden = true;
      var nm = name.value.trim();
      if (!nm) { fail('Nama ruangan wajib diisi.'); return; }
      var c = cap.value === '' ? null : parseInt(cap.value, 10);
      if (c !== null && !(c >= 0)) { fail('Kapasitas harus berupa angka 0 atau lebih.'); return; }
      var ord = parseInt(order.value, 10);
      var payload = { area_id: parseInt(areaSel.value, 10), name: nm, capacity: c,
                      description: descr.value.trim() || null, sort_order: isNaN(ord) ? 0 : ord };
      saveBtn.disabled = true;
      try {
        var res = editing
          ? await sb.from('rooms').update(payload).eq('id', room.id).select('id')
          : await sb.from('rooms').insert(payload).select('id');
        if (res.error) { fail(errText(res.error)); return; }
        if (!res.data || !res.data.length) { fail('Tidak ada yang tersimpan (tidak punya izin admin?).'); return; }
        closeDialog();
        showMsg(editing ? 'Ruangan diperbarui.' : 'Ruangan ditambahkan.', true);
        await refreshAdmin();
      } finally {
        saveBtn.disabled = false;
      }
    }

    openDialog(h('form', { onsubmit: submit },
      h('h3', null, editing ? 'Ubah Ruangan' : 'Tambah Ruangan'), err,
      row('Area', areaSel),
      row('Nama ruangan', name),
      row('Kapasitas', cap),
      row('Keterangan', descr),
      row('Urutan', order),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: closeDialog }, 'Batal'), saveBtn)));
    name.focus();
  }

  async function openAdminDelete(table, rowData) {
    if (!isAdmin()) { return; }
    var isArea = table === 'areas';
    var ids = isArea
      ? adminData.rooms.filter(function (x) { return x.area_id === rowData.id; }).map(function (x) { return x.id; })
      : [rowData.id];
    var count = 0;
    if (ids.length) {
      var c = await sb.from('entries').select('id', { count: 'exact', head: true }).in('room_id', ids);
      if (c.error) { showMsg('Gagal memeriksa jadwal: ' + errText(c.error)); return; }
      count = c.count || 0;
    }
    var confirmIn = count > 0
      ? h('input', { type: 'text', name: 'confirm', placeholder: 'Ketik HAPUS', autocomplete: 'off' })
      : null;
    var err = h('div', { class: 'ferr', hidden: true });
    function fail(t) { err.textContent = t; err.hidden = false; }

    async function doDelete() {
      if (confirmIn && confirmIn.value.trim() !== 'HAPUS') { fail('Ketik HAPUS (huruf besar) untuk memastikan.'); return; }
      var res = await sb.from(table).delete().eq('id', rowData.id).select('id');
      if (res.error) { fail(errText(res.error)); return; }
      if (!res.data || !res.data.length) { fail('Tidak ada yang terhapus (tidak punya izin admin?).'); return; }
      closeDialog();
      showMsg((isArea ? 'Area' : 'Ruangan') + ' dihapus.', true);
      await refreshAdmin();
    }

    openDialog([
      h('h3', null, (isArea ? 'Hapus area' : 'Hapus ruangan') + '?'),
      h('p', null, rowData.name),
      h('p', null, isArea
        ? 'Area ini memiliki ' + ids.length + ' ruangan dan ' + count + ' jadwal. Semuanya akan terhapus permanen.'
        : 'Ruangan ini memiliki ' + count + ' jadwal. Semuanya akan terhapus permanen.'),
      h('p', { class: 'muted' }, 'Untuk menyembunyikan tanpa menghapus data, gunakan tombol Nonaktifkan.'),
      confirmIn ? row('Konfirmasi', confirmIn) : null,
      err,
      h('div', { class: 'actions' },
        h('button', { onclick: closeDialog }, 'Batal'),
        h('button', { class: 'danger', onclick: doDelete }, 'Ya, hapus permanen'))
    ]);
  }

  // ------------------------------------------------------------------ menu atas & kalender mini
  var PAGE_TITLES = { rooms: 'Daftar Ruangan', report: 'Laporan', search: 'Hasil Pencarian', users: 'Pengguna', admin: 'Kelola Area & Ruang' };
  var PAGE_VIEWS = { admin: renderAdmin, users: renderUsers, rooms: renderRooms, search: renderSearch, report: renderReport };

  function renderNav() {
    var nav = $('nav');
    var sched = S.view === 'list' ? 'list' : 'day';
    function item(label, view, active) {
      return h('a', { class: 'navitem' + (active ? ' on' : ''), href: hashFor({ view: view }) }, label);
    }
    var q = h('input', { type: 'search', name: 'q', placeholder: 'kata kunci', value: S.view === 'search' ? S.q : '', 'aria-label': 'Cari acara' });
    var form = h('form', { class: 'navsearch', onsubmit: function (ev) {
      ev.preventDefault();
      var t = q.value.trim();
      if (t) { go({ view: 'search', q: t }); }
    } }, h('label', null, 'Cari: ', q));
    var items = [
      item('Jadwal', sched, S.view === 'day' || S.view === 'list'),
      item('Ruang', 'rooms', S.view === 'rooms'),
      item('Laporan', 'report', S.view === 'report'),
      form];
    if (isAdmin()) {
      // menu admin berada di sisi kanan menu atas, tepat di sebelah blok pengguna
      var manage = item('Kelola Area & Ruang', 'admin', S.view === 'admin');
      manage.className += ' push';
      items.push(manage, item('Pengguna', 'users', S.view === 'users'));
    }
    nav.replaceChildren.apply(nav, items);
  }

  // Tiga kalender bulan (bulan sebelumnya, bulan terpilih, bulan berikutnya) seperti di MRBS
  function renderMiniCal() {
    var box = $('minical');
    var base = L.firstOfMonth(S.date);
    var today = L.todayStr(OFF);
    var sched = S.view === 'list' ? 'list' : 'day';
    var months = [L.shiftMonth(base, -1), base, L.shiftMonth(base, 1)];
    var tables = months.map(function (m) {
      var y = parseInt(m.slice(0, 4), 10), mo = parseInt(m.slice(5, 7), 10);
      return h('table', { class: 'mc' },
        h('caption', null, h('a', { href: hashFor({ view: sched, date: m }) }, L.monthTitle(y, mo))),
        h('thead', null, h('tr', null, L.DAY_ABBR.map(function (d) { return h('th', null, d); }))),
        h('tbody', null, L.monthMatrix(y, mo).map(function (week) {
          return h('tr', null, week.map(function (d) {
            if (!d) { return h('td', null); }
            var ds = m.slice(0, 8) + L.pad(d);
            var cls = (ds === today ? 'today ' : '') + (ds === S.date ? 'sel' : '');
            return h('td', null, h('a', { class: cls.trim(), href: hashFor({ view: sched, date: ds }) }, d));
          }));
        })));
    });
    var prev = h('a', { class: 'mcnav', title: 'Bulan sebelumnya', href: hashFor({ view: sched, date: L.shiftMonth(S.date, -1) }) }, '\u2039');
    var next = h('a', { class: 'mcnav', title: 'Bulan berikutnya', href: hashFor({ view: sched, date: L.shiftMonth(S.date, 1) }) }, '\u203A');
    box.replaceChildren.apply(box, [prev].concat(tables, [next]));
  }

  // ------------------------------------------------------------------ tabel acara (pencarian & laporan)
  function entriesTable(list) {
    var rows = list.map(function (e) {
      var s = Date.parse(e.start_time), en = Date.parse(e.end_time);
      var sd = L.msToDate(s, OFF), ed = L.msToDate(en, OFF);
      return h('tr', { class: 'row', onclick: function () { openDetail(e); } },
        h('td', { class: 'time' }, L.shortDate(sd)),
        h('td', { class: 'time' }, L.msToTime(s, OFF) + ' - ' + L.msToTime(en, OFF) + (ed !== sd ? ' (' + L.shortDate(ed) + ')' : '')),
        h('td', null, h('span', { class: 'dot', style: { backgroundColor: L.entryColor(e) } }), e.name,
          e.tentative ? h('span', { class: 'tag' }, 'Tentatif') : null,
          h('span', { class: 'tag' }, L.TYPE_LABELS[e.type] || e.type)),
        h('td', null, e.room_name, h('div', { class: 'muted' }, e.area_name)),
        h('td', null, e.created_by_name || ''));
    });
    return h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, 'Tanggal'), h('th', null, 'Waktu'), h('th', null, 'Acara'),
        h('th', null, 'Ruang'), h('th', null, 'Dibuat oleh'))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 5 }, 'Tidak ada acara.'))));
  }

  // ------------------------------------------------------------------ halaman Ruang
  function renderRooms() {
    var main = $('main');
    nowCtx = null;
    clearErr();
    if (!S.areas.length) {
      main.replaceChildren(h('div', { class: 'notice' }, isAdmin() ? 'Belum ada area. Tambahkan lewat menu Kelola Area & Ruang.' : 'Belum ada area/ruangan.'));
      return;
    }
    var parts = S.areas.map(function (a) {
      var rs = S.rooms.filter(function (r) { return r.area_id === a.id; });
      var table = rs.length
        ? h('table', { class: 'list' },
            h('thead', null, h('tr', null, h('th', null, 'Ruangan'), h('th', null, 'Kapasitas'), h('th', null, 'Keterangan'))),
            h('tbody', null, rs.map(function (r) {
              return h('tr', null, h('td', null, r.name),
                h('td', null, (r.capacity === null || r.capacity === undefined) ? '-' : r.capacity + ' orang'),
                h('td', null, r.description || ''));
            })))
        : h('p', { class: 'muted' }, 'Belum ada ruangan di area ini.');
      return h('section', { class: 'card' },
        h('div', { class: 'cardhead' },
          h('div', null, h('strong', null, a.name),
            h('div', { class: 'muted' }, L.minutesToTime(a.start_hour * 60) + ' - ' + L.minutesToTime(a.end_hour * 60) + ' \u2022 ' + rs.length + ' ruangan')),
          h('div', { class: 'btns' }, h('a', { class: 'btn', href: hashFor({ view: 'day', area: a.id }) }, 'Lihat jadwal'))),
        table);
    });
    main.replaceChildren.apply(main, parts);
  }

  // ------------------------------------------------------------------ halaman Pencarian
  async function renderSearch() {
    var main = $('main');
    nowCtx = null;
    var q = (S.q || '').trim();
    if (!q) {
      main.replaceChildren(h('div', { class: 'notice' }, 'Ketik kata kunci di kotak "Cari" pada menu atas, lalu tekan Enter.'));
      return;
    }
    var token = ++loadToken;
    main.replaceChildren(h('div', { class: 'notice' }, 'Mencari...'));
    var pat = '%' + L.escapeLike(q) + '%';
    var fromIso = L.toIso(L.todayStr(OFF), '00:00', OFF);
    var results = await Promise.all(['name', 'description', 'created_by_name'].map(function (col) {
      var x = sb.from('events').select('*').ilike(col, pat);
      if (!S.searchAll) { x = x.gte('end_time', fromIso); }
      return x.order('start_time', { ascending: !S.searchAll }).limit(100);
    }));
    if (token !== loadToken) { return; }
    var bad = results.filter(function (r) { return r.error; })[0];
    if (bad) {
      showMsg('Pencarian gagal: ' + errText(bad.error));
      main.replaceChildren();
      return;
    }
    clearErr();
    var seen = {}, merged = [];
    results.forEach(function (r) {
      r.data.forEach(function (e) { if (!seen[e.id]) { seen[e.id] = true; merged.push(e); } });
    });
    merged.sort(function (a, b) {
      var d = Date.parse(a.start_time) - Date.parse(b.start_time);
      return S.searchAll ? -d : d;
    });
    var capped = merged.length > 100;
    merged = merged.slice(0, 100);
    var all = h('input', { type: 'checkbox', checked: S.searchAll, onchange: function () { S.searchAll = all.checked; renderSearch(); } });
    var parts = [
      h('h2', { class: 'daytitle' }, merged.length + ' hasil untuk "' + q + '"'),
      h('p', null, h('label', null, all, ' Termasuk acara yang sudah lewat')),
      entriesTable(merged)];
    if (capped) { parts.push(h('p', { class: 'muted' }, 'Hanya 100 hasil teratas yang ditampilkan. Persempit kata kunci.')); }
    main.replaceChildren.apply(main, parts);
  }

  // ------------------------------------------------------------------ halaman Laporan
  var RPT = { from: L.firstOfMonth(L.todayStr(OFF)), to: L.lastOfMonth(L.todayStr(OFF)), areaId: 0, roomId: 0, result: null };

  function renderReport() {
    var main = $('main');
    nowCtx = null;
    clearErr();
    var fromIn = h('input', { type: 'date', name: 'from', value: RPT.from });
    var toIn = h('input', { type: 'date', name: 'to', value: RPT.to });
    var roomSel = h('select', { name: 'room' });
    var areaSel = h('select', { name: 'area', onchange: function () {
      RPT.areaId = parseInt(areaSel.value, 10) || 0;
      RPT.roomId = 0;
      fillRooms();
    } }, h('option', { value: 0, selected: RPT.areaId === 0 }, 'Semua area'),
      S.areas.map(function (a) { return h('option', { value: a.id, selected: a.id === RPT.areaId }, a.name); }));
    function fillRooms() {
      var list = S.rooms.filter(function (r) { return !RPT.areaId || r.area_id === RPT.areaId; });
      roomSel.replaceChildren.apply(roomSel, [h('option', { value: 0 }, 'Semua ruangan')].concat(list.map(function (r) {
        return h('option', { value: r.id, selected: r.id === RPT.roomId }, r.name);
      })));
    }
    fillRooms();
    var showBtn = h('button', { class: 'primary', onclick: runReport }, 'Tampilkan');

    async function runReport() {
      if (!L.parseDate(fromIn.value) || !L.parseDate(toIn.value)) { showMsg('Tanggal tidak valid.'); return; }
      if (toIn.value < fromIn.value) { showMsg('Tanggal akhir harus sama dengan atau setelah tanggal awal.'); return; }
      RPT.from = fromIn.value;
      RPT.to = toIn.value;
      RPT.areaId = parseInt(areaSel.value, 10) || 0;
      RPT.roomId = parseInt(roomSel.value, 10) || 0;
      clearErr();
      showBtn.disabled = true;
      try {
        var fromIso = L.toIso(RPT.from, '00:00', OFF), toIso = L.toIso(L.addDays(RPT.to, 1), '00:00', OFF);
        var rows = [], page = 0, PAGE = 1000, MAX = 20000, capped = false;
        for (;;) {
          var q = sb.from('events').select('*').lt('start_time', toIso).gt('end_time', fromIso);
          if (RPT.areaId) { q = q.eq('area_id', RPT.areaId); }
          if (RPT.roomId) { q = q.eq('room_id', RPT.roomId); }
          var res = await q.order('start_time').order('id').range(page * PAGE, page * PAGE + PAGE - 1);
          if (res.error) { showMsg('Gagal memuat laporan: ' + errText(res.error)); return; }
          rows = rows.concat(res.data);
          if (res.data.length < PAGE) { break; }
          page++;
          if (rows.length >= MAX) { capped = true; break; }
        }
        RPT.result = { rows: rows, capped: capped, fromMs: Date.parse(fromIso), toMs: Date.parse(toIso) };
      } finally {
        showBtn.disabled = false;
      }
      renderReport();
    }

    var parts = [h('div', { class: 'card' }, h('div', { class: 'inline filters' },
      h('label', null, 'Dari ', fromIn), h('label', null, 'Sampai ', toIn),
      h('label', null, 'Area ', areaSel), h('label', null, 'Ruangan ', roomSel), showBtn))];

    if (RPT.result) {
      var res0 = RPT.result;
      var sum = L.summarizeByRoom(res0.rows, res0.fromMs, res0.toMs);
      var totalMin = sum.reduce(function (m, r) { return m + r.minutes; }, 0);
      parts.push(h('h2', { class: 'daytitle' }, 'Ringkasan ' + L.shortDate(RPT.from) + ' \u2013 ' + L.shortDate(RPT.to)));
      parts.push(h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Area'), h('th', null, 'Ruangan'), h('th', null, 'Jumlah acara'), h('th', null, 'Total jam'))),
        h('tbody', null, sum.length ? sum.map(function (r) {
          return h('tr', null, h('td', null, r.area_name), h('td', null, r.room_name), h('td', null, r.count), h('td', null, L.formatHours(r.minutes)));
        }) : h('tr', null, h('td', { colspan: 4 }, 'Tidak ada acara pada rentang ini.'))),
        sum.length ? h('tfoot', null, h('tr', null, h('th', { colspan: 2 }, 'Total'),
          h('th', null, res0.rows.length), h('th', null, L.formatHours(totalMin)))) : null));
      parts.push(h('p', null, h('button', { onclick: function () { downloadReportCsv(res0); } }, 'Unduh CSV (' + res0.rows.length + ' acara)')));
      if (res0.capped) { parts.push(h('p', { class: 'muted' }, 'Data dibatasi 20.000 acara pertama. Persempit rentang tanggal.')); }
      parts.push(h('h2', { class: 'daytitle' }, 'Rincian'));
      parts.push(entriesTable(res0.rows.slice(0, 500)));
      if (res0.rows.length > 500) { parts.push(h('p', { class: 'muted' }, 'Rincian menampilkan 500 acara pertama; berkas CSV memuat semuanya.')); }
    }
    main.replaceChildren.apply(main, parts);
  }

  function downloadReportCsv(res) {
    var head = ['Tanggal', 'Mulai', 'Selesai', 'Tanggal selesai', 'Acara', 'Deskripsi', 'Ruang', 'Area', 'Tipe', 'Status', 'Dibuat oleh'];
    var lines = [L.csvLine(head)];
    res.rows.forEach(function (e) {
      var s = Date.parse(e.start_time), en = Date.parse(e.end_time);
      lines.push(L.csvLine([L.msToDate(s, OFF), L.msToTime(s, OFF), L.msToTime(en, OFF), L.msToDate(en, OFF),
        e.name, e.description || '', e.room_name, e.area_name, L.TYPE_LABELS[e.type] || e.type,
        e.tentative ? 'Tentatif' : 'Dikonfirmasi', e.created_by_name || '']));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'laporan-simeru-' + RPT.from + '_sd_' + RPT.to + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ------------------------------------------------------------------ halaman Pengguna (admin)
  // Semua operasi lewat Edge Function "admin-users": membuat/mengubah akun butuh kunci service_role,
  // yang hanya boleh ada di server. Fungsi itu memeriksa ulang bahwa pemanggilnya admin.
  async function callAdmin(body) {
    var res = await sb.functions.invoke('admin-users', { body: body });
    if (!res.error) { return { data: res.data }; }
    var status = null;
    var msg = res.error.message || 'Gagal memanggil fungsi admin-users.';
    var ctx = res.error.context;
    if (ctx && typeof ctx.json === 'function') {
      status = ctx.status;
      try {
        var j = await ctx.json();
        if (j && j.error) { msg = j.error; }
      } catch (e) { /* isi respons bukan JSON: pakai pesan bawaan */ }
    }
    // 404 dari gateway atau gagal terhubung = fungsi belum di-deploy
    var notDeployed = status === 404 || res.error.name === 'FunctionsFetchError';
    return { error: { message: msg, status: status, notDeployed: notDeployed } };
  }

  function randomBytes(n) {
    var a = new Uint8Array(n);
    window.crypto.getRandomValues(a);
    return a;
  }

  async function renderUsers() {
    var main = $('main');
    nowCtx = null;
    if (!isAdmin()) {
      main.replaceChildren(h('div', { class: 'notice' }, 'Menu ini hanya untuk admin.'));
      return;
    }
    var token = ++loadToken;
    var res = await callAdmin({ action: 'list' });
    if (token !== loadToken) { return; }
    if (res.error) {
      main.replaceChildren(h('div', { class: 'notice' }, res.error.notDeployed
        ? [h('p', null, 'Fungsi "admin-users" belum dipasang di Supabase (atau tidak bisa dijangkau).'),
           h('p', null, 'Pasang dengan: supabase functions deploy admin-users. Langkah lengkap ada di README, bagian "Kelola pengguna".')]
        : 'Gagal memuat daftar pengguna: ' + res.error.message));
      return;
    }
    clearErr();
    var me = S.session ? S.session.user.id : null;
    function day(ts) { return ts ? L.shortDate(L.msToDate(Date.parse(ts), OFF)) : '-'; }
    var rows = (res.data.users || []).map(function (u) {
      return h('tr', { class: u.disabled ? 'off' : '' },
        h('td', null, u.email || ''),
        h('td', null, u.display_name || ''),
        h('td', null, u.role === 'admin' ? h('strong', null, 'admin') : 'pengguna'),
        h('td', null, u.disabled ? h('span', { class: 'tag' }, 'Nonaktif') : 'Aktif'),
        h('td', null, day(u.created_at)),
        h('td', null, day(u.last_sign_in_at)),
        h('td', null, h('div', { class: 'btns' },
          h('button', { onclick: function () { openUserForm(u); } }, 'Ubah'),
          u.id === me ? h('span', { class: 'muted' }, 'akun Anda') : null)));
    });
    main.replaceChildren(
      h('p', { class: 'muted' }, 'Pengguna yang dinonaktifkan tidak bisa masuk lagi (sesi yang sedang aktif berakhir dalam sekitar satu jam). ' +
        'Jadwal yang pernah dibuat tetap tersimpan.'),
      h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Email'), h('th', null, 'Nama'), h('th', null, 'Peran'), h('th', null, 'Status'),
          h('th', null, 'Terdaftar'), h('th', null, 'Login terakhir'), h('th', null, ''))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 7 }, 'Belum ada pengguna.')))));
  }

  // Form tambah (u = null) atau ubah pengguna
  function openUserForm(u) {
    if (!isAdmin()) { return; }
    var editing = !!u;
    var isMe = editing && !!S.session && u.id === S.session.user.id;
    var email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'off', value: editing ? u.email : '' });
    var nm = h('input', { type: 'text', name: 'display_name', maxlength: 100, value: editing ? (u.display_name || '') : '' });
    var pass = h('input', { type: 'text', name: 'password', autocomplete: 'new-password', spellcheck: 'false',
      placeholder: editing ? 'kosongkan bila tidak diubah' : 'minimal 8 karakter' });
    var gen = h('button', { type: 'button', onclick: function () { pass.value = L.genPassword(12, randomBytes); } }, 'Buat otomatis');
    var roleSel = h('select', { name: 'role', disabled: isMe },
      [['user', 'Pengguna'], ['admin', 'Admin']].map(function (r) {
        return h('option', { value: r[0], selected: (editing ? u.role : 'user') === r[0] }, r[1]);
      }));
    var active = h('input', { type: 'checkbox', name: 'active', checked: !(editing && u.disabled), disabled: isMe });
    var err = h('div', { class: 'ferr', hidden: true });
    function fail(t) { err.textContent = t; err.hidden = false; }
    var saveBtn = h('button', { type: 'submit', class: 'primary' }, 'Simpan');

    async function submit(ev) {
      ev.preventDefault();
      err.hidden = true;
      var em = email.value.trim().toLowerCase(), name = nm.value.trim(), pw = pass.value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { fail('Email tidak valid.'); return; }
      if (!editing && pw.length < 8) { fail('Password minimal 8 karakter.'); return; }
      if (editing && pw && pw.length < 8) { fail('Password baru minimal 8 karakter.'); return; }
      var body;
      if (!editing) {
        body = { action: 'create', email: em, password: pw, display_name: name, role: roleSel.value };
      } else {
        body = { action: 'update', id: u.id };                  // hanya kirim yang berubah
        if (em !== (u.email || '').toLowerCase()) { body.email = em; }
        if (name !== (u.display_name || '')) { body.display_name = name; }
        if (!isMe && roleSel.value !== u.role) { body.role = roleSel.value; }
        if (!isMe && active.checked === !!u.disabled) { body.disabled = !active.checked; }
        if (pw) { body.password = pw; }
        if (Object.keys(body).length === 2) { fail('Tidak ada perubahan.'); return; }
      }
      saveBtn.disabled = true;
      try {
        var res = await callAdmin(body);
        if (res.error) { fail(res.error.message); return; }
        closeDialog();
        showMsg(editing ? 'Pengguna diperbarui.' : 'Pengguna ' + em + ' dibuat.', true);
        if (isMe) { await loadProfile(); renderHeader(); }
        renderUsers();
      } finally {
        saveBtn.disabled = false;
      }
    }

    var rows = [
      row('Email', email),
      row('Nama', nm),
      row(editing ? 'Password baru' : 'Password', h('div', { class: 'inline' }, pass, gen)),
      row('Peran', roleSel)
    ];
    if (editing) {
      rows.push(row('Status', h('label', null, active, ' Akun aktif (boleh masuk)')));
      if (isMe) { rows.push(row('', h('span', { class: 'muted' }, 'Anda tidak bisa mengubah peran atau menonaktifkan akun sendiri.'))); }
    } else {
      rows.push(row('', h('span', { class: 'muted' }, 'Berikan password ini kepada pengguna. Mereka bisa menggantinya lewat tombol "Ganti password".')));
    }
    openDialog(h('form', { onsubmit: submit },
      h('h3', null, editing ? 'Ubah Pengguna' : 'Tambah Pengguna'), err, rows,
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: closeDialog }, 'Batal'), saveBtn)));
    (editing ? nm : email).focus();
  }

  // Ganti password akun sendiri (semua pengguna yang sudah masuk)
  function openChangePassword() {
    if (!S.session) { return; }
    var p1 = h('input', { type: 'password', name: 'new_password', autocomplete: 'new-password', required: true });
    var p2 = h('input', { type: 'password', name: 'confirm_password', autocomplete: 'new-password', required: true });
    var err = h('div', { class: 'ferr', hidden: true });
    function fail(t) { err.textContent = t; err.hidden = false; }
    var saveBtn = h('button', { type: 'submit', class: 'primary' }, 'Simpan');
    async function submit(ev) {
      ev.preventDefault();
      err.hidden = true;
      if (p1.value.length < 8) { fail('Password minimal 8 karakter.'); return; }
      if (p1.value !== p2.value) { fail('Konfirmasi password tidak sama.'); return; }
      saveBtn.disabled = true;
      try {
        var res = await sb.auth.updateUser({ password: p1.value });
        if (res.error) { fail(res.error.message); return; }
        closeDialog();
        showMsg('Password diperbarui.', true);
      } finally {
        saveBtn.disabled = false;
      }
    }
    openDialog(h('form', { onsubmit: submit },
      h('h3', null, 'Ganti Password'), err,
      row('Password baru', p1), row('Ulangi password', p2),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: closeDialog }, 'Batal'), saveBtn)));
    p1.focus();
  }

  // ------------------------------------------------------------------ realtime
  var reloadTimer = null;
  function scheduleReload() {
    if (S.view !== 'day' && S.view !== 'list') { return; }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadEntries, 300);
  }
  function startRealtime() {
    sb.channel('entries-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, scheduleReload)
      .subscribe(function (status) { setLive(status === 'SUBSCRIBED'); });
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && (S.view === 'day' || S.view === 'list')) { loadEntries(); positionNow(); }
  });

  // ------------------------------------------------------------------ mulai
  sb.auth.onAuthStateChange(function (event, session) {
    // jangan memanggil Supabase langsung di dalam callback ini (bisa deadlock)
    setTimeout(async function () {
      S.session = session;
      await loadProfile();
      renderHeader();
      if ((S.view === 'admin' || S.view === 'users') && !isAdmin()) { go({ view: 'day' }); } else { renderToolbar(); }
    }, 0);
  });

  window.addEventListener('hashchange', function () { readHash(); normalize(); renderToolbar(); loadEntries(); });

  (async function init() {
    readHash();
    try {
      var sess = await sb.auth.getSession();
      S.session = sess.data.session;
      await loadProfile();
      renderHeader();
      await loadStatic();
    } catch (err) {
      $('main').replaceChildren(h('div', { class: 'notice' }, 'Gagal terhubung ke Supabase: ' + errText(err)));
      return;
    }
    writeHash();
    renderToolbar();
    await loadEntries();
    startRealtime();
  })();
})();
