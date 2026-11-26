// SIMERU - frontend statis (GitHub Pages) + Supabase.
(function () {
  'use strict';

  var cfg = Object.assign({
    APP_TITLE: 'SIMERU', TIMEZONE: 'Asia/Jakarta', TZ_OFFSET: '+07:00', ALLOW_SIGNUP: false, FEED_URL: ''
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

  function errText(err) {
    if (!err) { return 'Terjadi kesalahan.'; }
    if (err.code === '23P01') { return 'Bentrok: ruangan sudah dipakai pada jam tersebut.'; }
    if (err.code === '42501') { return 'Anda tidak punya izin untuk tindakan ini.'; }
    return err.message || String(err);
  }

  // ------------------------------------------------------------------ URL hash
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    var d = p.get('date');
    if (d && L.parseDate(d)) { S.date = d; }
    var a = parseInt(p.get('area'), 10);
    if (a >= 0) { S.areaId = a; }
    var v = p.get('view');
    if (v === 'day' || v === 'list') { S.view = v; }
  }
  function writeHash() {
    var p = new URLSearchParams();
    p.set('view', S.view);
    p.set('date', S.date);
    if (S.areaId !== null) { p.set('area', S.areaId); }
    history.replaceState(null, '', '#' + p.toString());
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
    showMsg('');
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
    box.replaceChildren();
    if (S.session) {
      var name = (S.profile && S.profile.display_name) || S.session.user.email;
      box.append(h('span', null, name + (isAdmin() ? ' (admin)' : '')),
        h('button', { onclick: function () { sb.auth.signOut(); } }, 'Keluar'));
    } else {
      box.append(h('button', { onclick: function () { openLogin(); } }, 'Masuk'));
    }
  }

  function renderToolbar() {
    var tb = $('toolbar');
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
      main.replaceChildren(h('div', { class: 'notice' }, 'Belum ada area. Tambahkan data di tabel "areas" dan "rooms" pada Supabase.'));
      return;
    }
    var rooms = S.rooms.filter(function (r) { return r.area_id === area.id; });
    if (!rooms.length) {
      main.replaceChildren(h('div', { class: 'notice' }, 'Area ini belum punya ruangan (tabel "rooms").'));
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

  // ------------------------------------------------------------------ realtime
  var reloadTimer = null;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadEntries, 300);
  }
  function startRealtime() {
    sb.channel('entries-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, scheduleReload)
      .subscribe(function (status) { setLive(status === 'SUBSCRIBED'); });
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { loadEntries(); positionNow(); }
  });

  // ------------------------------------------------------------------ mulai
  sb.auth.onAuthStateChange(function (event, session) {
    // jangan memanggil Supabase langsung di dalam callback ini (bisa deadlock)
    setTimeout(async function () {
      S.session = session;
      await loadProfile();
      renderHeader();
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
