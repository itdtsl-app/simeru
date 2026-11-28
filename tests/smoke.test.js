// Uji asap: menjalankan web/app.js dengan DOM palsu + klien Supabase tiruan.
// Jalankan: node tests/smoke.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('../web/lib.js');

// ---------- DOM palsu minimal ----------
class Txt { constructor(t) { this.nodeType = 3; this.textContent = String(t); } }
class El {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {};
    this.style = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.open = false;
    this._value = ''; this._text = null; this._cls = new Set();
    const self = this;
    this.classList = {
      toggle(c, on) { if (on) self._cls.add(c); else self._cls.delete(c); },
      add(c) { self._cls.add(c); }, remove(c) { self._cls.delete(c); }
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'value') this._value = v; }
  get value() {
    if (this.tagName === 'SELECT') {
      const opts = this.children.filter((c) => c.tagName === 'OPTION');
      const sel = opts.filter((o) => o.selected)[0] || opts[0];
      return sel ? sel.attrs.value + '' : '';
    }
    return this._value;
  }
  set value(v) { this._value = v; }
  get selected() { return 'selected' in this.attrs; }
  get checked() { return 'checked' in this.attrs; }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
  get lastChild() { return this.children[this.children.length - 1]; }
  get textContent() { return this._text !== null ? this._text : this.children.map((c) => c.textContent).join(''); }
  set textContent(t) { this._text = String(t); this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  // Meniru DOM asli: yang bukan Node (null, array, angka) diubah menjadi teks, seperti String(x) di browser
  append(...cs) { cs.forEach((c) => this.children.push(c && c.nodeType ? c : new Txt(String(c)))); }
  replaceChildren(...cs) { this.children = []; this._text = null; this.append(...cs); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  querySelectorAll(sel) { const cls = sel.replace('.', ''); return all(this).filter((e) => e.className.split(' ').includes(cls)); }
  getBoundingClientRect() { return { top: 0 }; }
  focus() {} scrollIntoView() {}
  showModal() { this.open = true; } close() { this.open = false; }
  async fire(type, ev) { for (const f of this.listeners[type] || []) { await f(ev || { preventDefault() {}, stopPropagation() {}, target: this, clientY: 0 }); } }
}
function all(el) { return el.children.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...all(c)]); }
function find(root, pred) { return all(root).filter(pred); }
const btn = (root, text) => find(root, (e) => e.tagName === 'BUTTON' && e.textContent === text)[0];
const input = (root, name) => find(root, (e) => e.attrs.name === name)[0];
const plain = (v) => JSON.parse(JSON.stringify(v));   // objek dari sandbox VM -> objek biasa
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const today = L.todayStr('+07:00');
const iso = (d, t) => L.toIso(d, t, '+07:00');

// ---------- lingkungan palsu (DOM + Supabase) ----------
function makeEnv(role, hash, opts) {
  opts = opts || {};
  const byId = {};
  ['title', 'nav', 'userbox', 'toolbar', 'minical', 'msg', 'main', 'dlg'].forEach((id) => { byId[id] = new El(id === 'dlg' ? 'dialog' : 'div'); });
  const document = {
    getElementById: (id) => byId[id] ||
      ['nav', 'toolbar', 'minical', 'main', 'dlg', 'userbox'].flatMap((k) => find(byId[k], (e) => e.attrs.id === id))[0] || null,
    createElement: (t) => new El(t), createTextNode: (t) => new Txt(t),
    addEventListener() {}, title: '', hidden: false
  };
  const DATA = {
    areas: [{ id: 1, name: 'Ruang Pertemuan dan Seminar', start_hour: 7, end_hour: 19, slot_minutes: 30, sort_order: 0, disabled: false }],
    rooms: [{ id: 10, area_id: 1, name: 'Ruang A', capacity: 6, description: null, sort_order: 0, disabled: false },
            { id: 11, area_id: 1, name: 'Ruang B', capacity: 10, description: 'Lt. 2', sort_order: 1, disabled: false }],
    entries: [
      { id: 1, room_id: 10, start_time: iso(today, '08:30'), end_time: iso(today, '11:00'), name: 'Rapat Koordinasi', description: 'tes', type: 'I', color: '#ff9999', tentative: false, created_by: 'u1', created_by_name: 'paul', series_id: null },
      { id: 2, room_id: 11, start_time: iso(today, '13:00'), end_time: iso(today, '14:30'), name: 'Kuliah', description: null, type: 'E', color: null, tentative: true, created_by: 'u2', created_by_name: 'lain', series_id: 'abc' }
    ],
    events: [],
    users: [
      { id: 'u1', email: 'a@b.c', display_name: 'Paul', role: 'admin', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: '2026-11-27T01:00:00Z' },
      { id: 'u9', email: 'x@y.z', display_name: 'Budi', role: 'user', created_at: '2026-10-02T00:00:00Z', last_sign_in_at: null, disabled: false },
      { id: 'u7', email: 'lama@y.z', display_name: 'Lama', role: 'user', created_at: '2026-10-03T00:00:00Z', last_sign_in_at: null, disabled: true }
    ],
    entryCount: 0
  };
  DATA.events = DATA.entries.map((e) => Object.assign({ room_name: 'Ruang', area_name: 'Area', area_id: 1 }, e));
  const calls = { rpc: [], ops: [], fn: [], auth: [] };
  function qb(table) {
    const st = { table, op: 'select', values: null, filters: [], head: false };
    const q = {
      select(cols, o) { if (o && o.head) st.head = true; return q; },
      insert(v) { st.op = 'insert'; st.values = v; return q; },
      update(v) { st.op = 'update'; st.values = v; return q; },
      delete() { st.op = 'delete'; return q; },
      eq(c, v) { st.filters.push(['eq', c, v]); return q; },
      in(c, v) { st.filters.push(['in', c, v]); return q; },
      lt() { return q; }, gt() { return q; }, gte() { return q; }, order() { return q; },
      ilike() { return q; }, limit() { return q; }, range() { return q; },
      maybeSingle: () => Promise.resolve({ data: { display_name: 'Paul', role }, error: null }),
      then(ok, ko) {
        let res;
        if (st.op === 'select') {
          res = st.head ? { data: null, count: DATA.entryCount, error: null } : { data: DATA[table] || [], error: null };
        } else {
          calls.ops.push(st);
          res = { data: [{ id: 99 }], error: null };
        }
        return Promise.resolve(res).then(ok, ko);
      }
    };
    return q;
  }
  const fakeSb = {
    from: qb,
    rpc: (name, args) => {
      calls.rpc.push({ name, args });
      if (name === 'list_users') {
        return Promise.resolve(opts.usersFnMissing
          ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.list_users' } }
          : { data: DATA.users, error: null });
      }
      if (name === 'set_user_role') { return Promise.resolve({ data: null, error: null }); }
      return Promise.resolve({ data: { created: 1, skipped: [] }, error: null });
    },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.c' } } } }),
      onAuthStateChange() {}, signOut() {}, signInWithPassword: () => Promise.resolve({ error: null }),
      updateUser: async (a) => { calls.auth.push(plain(a)); return { error: opts.pwError ? { message: opts.pwError } : null }; }
    },
    functions: {
      invoke: async (name, init) => {
        assert.strictEqual(name, 'admin-users');
        const body = init.body;
        calls.fn.push(plain(body));
        if (opts.usersFnMissing) {
          return { data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
            context: { status: 404, json: async () => ({ code: 'NOT_FOUND', message: 'Requested function was not found' }) } } };
        }
        if (opts.platformError) {
          const pe = opts.platformError;
          return { data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
            context: { status: pe.status, json: async () => pe.body } } };
        }
        if (opts.fnError && body.action !== 'list') {
          return { data: null, error: { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
            context: { status: 400, json: async () => ({ error: opts.fnError }) } } };
        }
        if (body.action === 'list') { return { data: { users: DATA.users }, error: null }; }
        return { data: { ok: true }, error: null };
      }
    },
    channel() { const c = { on() { return c; }, subscribe(cb) { cb('SUBSCRIBED'); return c; } }; return c; }
  };
  const sandbox = {
    document, console, Date, URLSearchParams, Promise, Object, Array, String, parseInt, Math, JSON, Number, isNaN, Uint8Array,
    crypto: require('crypto').webcrypto,
    setTimeout, clearTimeout, setInterval,
    location: { hash: hash || '' }, history: { replaceState() {} },
    SimeruLib: L
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.SIMERU_CONFIG = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', TZ_OFFSET: '+07:00', TIMEZONE: 'Asia/Jakarta' };
  sandbox.supabase = { createClient: () => fakeSb };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8'), sandbox);
  return { byId, DATA, calls };
}

// ======================================================================
async function scenarioUser() {
  const { byId, calls } = makeEnv('user');
  await wait(80);

  // 1) grid hari: 2 ruangan, 2 jadwal
  const main = byId.main;
  assert.strictEqual(find(main, (e) => e.className === 'rhead').length, 2, 'dua kolom ruangan');
  const blocks = find(main, (e) => e.className.startsWith('entry'));
  assert.strictEqual(blocks.length, 2, 'dua blok jadwal');
  const b1 = blocks[0];
  assert.strictEqual(b1.style.backgroundColor, '#ff9999', 'warna kustom dipakai');
  assert.strictEqual(b1.style.top, (3 * 22) + 'px');
  assert.strictEqual(b1.style.height, (5 * 22 - 1) + 'px');
  assert.strictEqual(blocks[1].style.backgroundColor, '#6dd9c4', 'tipe E bawaan tosca');
  assert.ok(blocks[1].className.includes('tentative'));
  assert.ok(byId.userbox.textContent.includes('Paul'), 'nama pengguna tampil');
  assert.ok(!byId.userbox.textContent.includes('Kelola'), 'pengguna biasa tidak melihat menu admin');
  assert.ok(btn(byId.userbox, 'Ganti password'), 'tombol Ganti password');
  assert.ok(!find(byId.nav, (e) => e.tagName === 'A').some((a) => /Kelola|Pengguna/.test(a.textContent)), 'menu atas pengguna biasa tanpa item admin');
  assert.ok(!/null|undefined|\[object/.test(byId.userbox.textContent + byId.toolbar.textContent + byId.main.textContent + byId.nav.textContent + byId.minical.textContent),
    'tidak ada teks "null"/"undefined"/"[object ...]" nyasar di halaman');
  assert.ok(byId.toolbar.textContent.includes('Live'), 'indikator live');

  // 2) detail: milik sendiri -> Ubah & Hapus; milik orang lain -> tidak ada
  await b1.fire('click');
  assert.ok(byId.dlg.open);
  let texts = find(byId.dlg, (e) => e.tagName === 'BUTTON').map((b) => b.textContent);
  assert.ok(texts.includes('Ubah') && texts.includes('Hapus'), 'pemilik boleh ubah/hapus: ' + texts);
  await blocks[1].fire('click');
  texts = find(byId.dlg, (e) => e.tagName === 'BUTTON').map((b) => b.textContent);
  assert.ok(!texts.includes('Ubah') && !texts.includes('Hapus'), 'bukan pemilik tidak boleh ubah');

  // 3) tambah jadwal -> RPC
  await btn(byId.toolbar, '+ Tambah jadwal').fire('click');
  const form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  assert.ok(form, 'form terbuka');
  find(form, (e) => e.tagName === 'INPUT' && e.attrs.type === 'text')[0].value = 'Rapat Uji';
  const swatches = find(form, (e) => e.className.startsWith('sw '));
  assert.strictEqual(swatches.length, 11, '1 default + 10 palet');
  await swatches[6].fire('click');
  await form.fire('submit');
  await wait(30);
  assert.strictEqual(calls.rpc.length, 1, 'RPC create_booking dipanggil');
  const a = calls.rpc[0].args;
  assert.deepStrictEqual(plain(a.p_room_ids), [10]);
  assert.strictEqual(a.p_name, 'Rapat Uji');
  assert.strictEqual(a.p_color, '#80bfff');
  assert.strictEqual(a.p_start, iso(today, '07:00'));
  assert.strictEqual(a.p_end, iso(today, '08:00'));
  assert.strictEqual(a.p_repeat, 'none');
  assert.strictEqual(a.p_tz, 'Asia/Jakarta');
  assert.ok(!byId.dlg.open, 'dialog tertutup setelah simpan');

  // 4) tampilan daftar
  await btn(byId.toolbar, 'Daftar').fire('click');
  await wait(30);
  assert.strictEqual(find(byId.main, (e) => e.className === 'row').length, 2, 'dua baris di daftar');
  assert.ok(byId.main.textContent.includes('Rapat Koordinasi'));
}

async function scenarioUserCannotOpenAdmin() {
  const { byId } = makeEnv('user', '#view=admin&date=' + today);
  await wait(80);
  assert.ok(find(byId.main, (e) => e.className.startsWith('entry')).length > 0, 'pengguna biasa dialihkan ke grid jadwal');
  assert.ok(!byId.main.textContent.includes('Hapus area'));
}

async function scenarioAdmin() {
  // menu atas: item admin berada di sisi kanan, setelah kotak Cari
  const first = makeEnv('admin');
  await wait(80);
  assert.ok(first.byId.userbox.textContent.includes('(admin)'));
  const navKids = first.byId.nav.children.filter((c) => c.nodeType === 1);
  assert.deepStrictEqual(navKids.map((k) => k.tagName === 'FORM' ? 'CARI' : k.textContent),
    ['Jadwal', 'Ruang', 'Laporan', 'CARI', 'Kelola Area & Ruang', 'Pengguna'], 'urutan menu atas untuk admin');
  const manage = navKids[4], usersLink = navKids[5];
  assert.ok(manage.attrs.href.startsWith('#view=admin') && manage.className.includes('push'), 'dorong ke kanan');
  assert.ok(usersLink.attrs.href.startsWith('#view=users'));
  assert.ok(!first.byId.userbox.textContent.includes('Kelola') && !first.byId.userbox.textContent.includes('Daftar pengguna'),
    'tautan admin tidak lagi di blok pengguna');

  const { byId, DATA, calls } = makeEnv('admin', '#view=admin');
  await wait(80);
  assert.ok(find(byId.nav, (e) => e.tagName === 'A' && e.textContent === 'Kelola Area & Ruang' && e.className.includes(' on')).length === 1, 'menu aktif ditandai');
  assert.ok(byId.toolbar.textContent.includes('Kelola Area & Ruang') && btn(byId.toolbar, '+ Tambah area'));
  assert.ok(btn(byId.toolbar, '\u2039 Kembali ke jadwal'));
  assert.ok(byId.main.textContent.includes('Ruang Pertemuan dan Seminar'), 'kartu area tampil');
  assert.ok(byId.main.textContent.includes('Ruang A') && byId.main.textContent.includes('Ruang B'), 'daftar ruangan tampil');
  assert.ok(byId.main.textContent.includes('07:00 - 19:00'));
  assert.ok(!/null|undefined|\[object/.test(byId.main.textContent + byId.toolbar.textContent + byId.userbox.textContent),
    'menu admin tidak menampilkan teks nyasar');

  // validasi: jam selesai sebelum jam mulai ditolak
  await btn(byId.toolbar, '+ Tambah area').fire('click');
  let form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  input(form, 'name').value = 'Area Baru';
  input(form, 'start_hour').value = '8';
  input(form, 'end_hour').value = '7';
  await form.fire('submit');
  assert.strictEqual(calls.ops.length, 0, 'validasi menahan penyimpanan');
  assert.ok(find(byId.dlg, (e) => e.className === 'ferr')[0].textContent.includes('Jam selesai'));
  // diperbaiki -> tersimpan
  input(form, 'end_hour').value = '17';
  await form.fire('submit');
  await wait(60);
  assert.strictEqual(calls.ops.length, 1);
  assert.strictEqual(calls.ops[0].table, 'areas');
  assert.strictEqual(calls.ops[0].op, 'insert');
  assert.deepStrictEqual(plain(calls.ops[0].values), { name: 'Area Baru', sort_order: 1, start_hour: 8, end_hour: 17, slot_minutes: 30 });
  assert.ok(!byId.dlg.open, 'dialog tertutup');
  assert.ok(byId.msg.textContent.includes('Area ditambahkan') && !byId.msg.hidden, 'pesan sukses tidak terhapus oleh muat ulang data');

  // tambah ruang di area 1
  await btn(byId.main, '+ Tambah ruang').fire('click');
  form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  input(form, 'name').value = 'Ruang Baru';
  input(form, 'capacity').value = '12';
  input(form, 'description').value = 'Lantai 3';
  await form.fire('submit');
  await wait(60);
  const roomOp = calls.ops[1];
  assert.strictEqual(roomOp.table, 'rooms');
  assert.strictEqual(roomOp.op, 'insert');
  assert.deepStrictEqual(plain(roomOp.values), { area_id: 1, name: 'Ruang Baru', capacity: 12, description: 'Lantai 3', sort_order: 2 });

  // nama kosong ditolak; kapasitas kosong -> null
  await btn(byId.main, '+ Tambah ruang').fire('click');
  form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  await form.fire('submit');
  assert.strictEqual(calls.ops.length, 2, 'nama kosong ditolak');
  input(form, 'name').value = 'Tanpa Kapasitas';
  await form.fire('submit');
  await wait(60);
  assert.strictEqual(calls.ops[2].values.capacity, null);
  assert.strictEqual(calls.ops[2].values.description, null);

  // nonaktifkan (tombol pertama dalam DOM = milik area)
  await btn(byId.main, 'Nonaktifkan').fire('click');
  await wait(60);
  const t = calls.ops[3];
  assert.strictEqual(t.table, 'areas');
  assert.strictEqual(t.op, 'update');
  assert.deepStrictEqual(plain(t.values), { disabled: true });
  assert.deepStrictEqual(plain(t.filters[0]), ['eq', 'id', 1]);

  // hapus area yang punya jadwal -> wajib ketik HAPUS
  DATA.entryCount = 5;
  await btn(byId.main, 'Hapus area').fire('click');
  await wait(30);
  assert.ok(byId.dlg.open);
  assert.ok(byId.dlg.textContent.includes('5 jadwal'), 'jumlah jadwal yang ikut terhapus ditampilkan');
  const before = calls.ops.length;
  await btn(byId.dlg, 'Ya, hapus permanen').fire('click');
  assert.strictEqual(calls.ops.length, before, 'tanpa ketik HAPUS tidak ada yang dihapus');
  assert.ok(find(byId.dlg, (e) => e.className === 'ferr')[0].textContent.includes('Ketik HAPUS'));
  input(byId.dlg, 'confirm').value = 'HAPUS';
  await btn(byId.dlg, 'Ya, hapus permanen').fire('click');
  await wait(60);
  const del = calls.ops[calls.ops.length - 1];
  assert.strictEqual(del.op, 'delete');
  assert.strictEqual(del.table, 'areas');
  assert.deepStrictEqual(plain(del.filters[0]), ['eq', 'id', 1]);

  // ruangan tanpa jadwal: tidak perlu mengetik apa pun
  DATA.entryCount = 0;
  await btn(byId.main, 'Hapus').fire('click');
  await wait(30);
  assert.ok(!input(byId.dlg, 'confirm'), 'tanpa jadwal tidak perlu konfirmasi ketik');
  assert.ok(byId.dlg.textContent.includes('0 jadwal'));
  await btn(byId.dlg, 'Batal').fire('click');

  // kembali ke jadwal
  await btn(byId.toolbar, '\u2039 Kembali ke jadwal').fire('click');
  await wait(40);
  assert.ok(find(byId.main, (e) => e.className.startsWith('entry')).length > 0, 'kembali ke grid');
}


async function scenarioMenuAndCalendar() {
  const { byId } = makeEnv('user');
  await wait(80);
  // menu atas
  const navLinks = find(byId.nav, (e) => e.tagName === 'A').map((a) => [a.textContent, a.attrs.href]);
  assert.deepStrictEqual(navLinks.map((x) => x[0]), ['Jadwal', 'Ruang', 'Laporan']);
  assert.ok(navLinks[1][1].startsWith('#view=rooms'), 'tautan Ruang');
  assert.ok(navLinks[2][1].startsWith('#view=report'), 'tautan Laporan');
  assert.ok(find(byId.nav, (e) => e.tagName === 'INPUT' && e.attrs.name === 'q')[0], 'kotak Cari');
  assert.ok(byId.userbox.textContent.includes('Paul'));

  // kalender 3 bulan: bulan sebelumnya, bulan ini, bulan berikutnya
  const base = L.firstOfMonth(today);
  const wanted = [L.shiftMonth(base, -1), base, L.shiftMonth(base, 1)].map((m) => L.monthTitle(+m.slice(0, 4), +m.slice(5, 7)));
  const tables = find(byId.minical, (e) => e.tagName === 'TABLE');
  assert.strictEqual(tables.length, 3, 'tiga kalender');
  assert.deepStrictEqual(tables.map((t) => find(t, (e) => e.tagName === 'CAPTION')[0].textContent), wanted);
  assert.deepStrictEqual(find(tables[1], (e) => e.tagName === 'TH').map((e) => e.textContent), ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']);
  // hari ini diberi penanda, tautan hari membawa tanggal yang benar
  const todayLinks = find(byId.minical, (e) => e.tagName === 'A' && e.className.split(' ').includes('today'));
  assert.strictEqual(todayLinks.length, 1);
  assert.strictEqual(todayLinks[0].textContent, String(+today.slice(8)));
  assert.ok(todayLinks[0].attrs.href.includes('date=' + today), todayLinks[0].attrs.href);
  assert.strictEqual(find(byId.minical, (e) => e.tagName === 'A' && e.className.split(' ').includes('sel')).length, 1, 'tanggal terpilih ditandai');
  const dayLinks = find(tables[1], (e) => e.tagName === 'A' && /^\d+$/.test(e.textContent));
  assert.strictEqual(dayLinks.length, new Date(Date.UTC(+base.slice(0, 4), +base.slice(5, 7), 0)).getUTCDate(), 'semua hari bulan ini tampil');
  assert.ok(find(byId.minical, (e) => e.className === 'mcnav').length === 2, 'panah bulan');

  // pencarian dari kotak Cari di menu atas
  const form = find(byId.nav, (e) => e.tagName === 'FORM')[0];
  find(form, (e) => e.tagName === 'INPUT')[0].value = 'rapat';
  await form.fire('submit');
  await wait(50);
  assert.ok(byId.toolbar.textContent.includes('Hasil Pencarian'));
  assert.ok(byId.main.textContent.includes('hasil untuk "rapat"'), byId.main.textContent.slice(0, 120));
  assert.strictEqual(find(byId.main, (e) => e.className === 'row').length, 2, 'hasil digabung tanpa duplikat');
  assert.ok(!/null|undefined|\[object/.test(byId.main.textContent + byId.nav.textContent + byId.minical.textContent));
}

async function scenarioRooms() {
  const { byId } = makeEnv('user', '#view=rooms');
  await wait(80);
  assert.ok(byId.toolbar.textContent.includes('Daftar Ruangan'));
  const t = byId.main.textContent;
  assert.ok(t.includes('Ruang Pertemuan dan Seminar') && t.includes('Ruang A') && t.includes('Ruang B'));
  assert.ok(t.includes('6 orang') && t.includes('10 orang') && t.includes('Lt. 2'));
  const link = find(byId.main, (e) => e.tagName === 'A' && e.textContent === 'Lihat jadwal')[0];
  assert.ok(link.attrs.href.includes('view=day') && link.attrs.href.includes('area=1'), link.attrs.href);
}

async function scenarioReport() {
  const { byId } = makeEnv('user', '#view=report');
  await wait(80);
  assert.ok(byId.toolbar.textContent.includes('Laporan'));
  assert.ok(input(byId.main, 'from').attrs.value === L.firstOfMonth(today), 'awal bulan ini');
  assert.ok(input(byId.main, 'to').attrs.value === L.lastOfMonth(today), 'akhir bulan ini');
  // validasi rentang terbalik
  input(byId.main, 'from').value = '2026-11-20';
  input(byId.main, 'to').value = '2026-11-10';
  await btn(byId.main, 'Tampilkan').fire('click');
  assert.ok(byId.msg.textContent.includes('Tanggal akhir'), 'rentang terbalik ditolak');
  assert.ok(!byId.main.textContent.includes('Ringkasan'));
  // rentang valid -> ringkasan (2,5 jam + 1,5 jam = 4,0 jam)
  input(byId.main, 'from').value = L.firstOfMonth(today);
  input(byId.main, 'to').value = L.lastOfMonth(today);
  await btn(byId.main, 'Tampilkan').fire('click');
  await wait(50);
  const t = byId.main.textContent;
  assert.ok(t.includes('Ringkasan'), t.slice(0, 200));
  assert.ok(t.includes('2,5') && t.includes('1,5') && t.includes('4,0'), 'jam per ruangan dan total');
  assert.ok(t.includes('Unduh CSV (2 acara)'));
  assert.strictEqual(find(byId.main, (e) => e.className === 'row').length, 2, 'rincian 2 acara');
  assert.ok(!/null|undefined|\[object/.test(t));
}

// memilih opsi pada <select> palsu
function pick(select, value) {
  select.children.filter((c) => c.tagName === 'OPTION').forEach((o) => {
    if (String(o.attrs.value) === String(value)) o.attrs.selected = ''; else delete o.attrs.selected;
  });
}
const uncheck = (el) => { delete el.attrs.checked; };
const check = (el) => { el.attrs.checked = ''; };
const formErr = (root) => find(root, (e) => e.className === 'ferr')[0].textContent;

async function scenarioUsers() {
  let env = makeEnv('admin', '#view=users');
  await wait(80);
  let { byId, calls } = env;
  assert.ok(byId.toolbar.textContent.includes('Pengguna'));
  assert.ok(find(byId.nav, (e) => e.tagName === 'A' && e.textContent === 'Pengguna' && e.className.includes('on')).length === 1, 'menu Pengguna aktif');
  assert.deepStrictEqual(calls.fn[0], { action: 'list' });
  let t = byId.main.textContent;
  assert.ok(t.includes('x@y.z') && t.includes('akun Anda') && t.includes('Nonaktif') && t.includes('Aktif'), t.slice(0, 200));
  assert.ok(!/null|undefined|\[object/.test(t));

  // ---- tambah pengguna: validasi lalu berhasil
  await btn(byId.toolbar, '+ Tambah pengguna').fire('click');
  let form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  assert.ok(form && byId.dlg.textContent.includes('Tambah Pengguna'));
  input(form, 'email').value = 'bukan-email';
  await form.fire('submit');
  assert.ok(formErr(byId.dlg).includes('Email tidak valid'));
  input(form, 'email').value = 'Baru@X.id';
  input(form, 'password').value = 'pendek';
  await form.fire('submit');
  assert.ok(formErr(byId.dlg).includes('minimal 8'));
  assert.strictEqual(calls.fn.length, 1, 'validasi menahan pemanggilan fungsi');
  await btn(form, 'Buat otomatis').fire('click');
  const pw = input(form, 'password').value;
  assert.strictEqual(pw.length, 12);
  assert.ok([...pw].every((c) => L.PW_ALPHABET.includes(c)), 'password otomatis memakai alfabet aman');
  input(form, 'display_name').value = 'Baru';
  pick(input(form, 'role'), 'admin');
  await form.fire('submit');
  await wait(60);
  assert.deepStrictEqual(calls.fn[1], { action: 'create', email: 'baru@x.id', password: pw, display_name: 'Baru', role: 'admin' });
  assert.ok(!byId.dlg.open, 'dialog tertutup');
  assert.ok(byId.msg.textContent.includes('baru@x.id') && !byId.msg.hidden, 'pesan sukses bertahan');
  assert.deepStrictEqual(calls.fn[2], { action: 'list' }, 'daftar dimuat ulang');

  // ---- ubah pengguna lain (baris ke-2 = Budi)
  const editBtns = () => find(byId.main, (e) => e.tagName === 'BUTTON' && e.textContent === 'Ubah');
  assert.strictEqual(editBtns().length, 3);
  await editBtns()[1].fire('click');
  form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  assert.ok(byId.dlg.textContent.includes('Ubah Pengguna'));
  assert.strictEqual(input(form, 'email').attrs.value, 'x@y.z');
  assert.ok(!input(form, 'role').attrs.disabled, 'peran pengguna lain bisa diubah');
  await form.fire('submit');                                           // belum ada perubahan
  assert.ok(formErr(byId.dlg).includes('Tidak ada perubahan'));
  input(form, 'display_name').value = 'Budi B';
  pick(input(form, 'role'), 'admin');
  uncheck(input(form, 'active'));
  input(form, 'password').value = 'PasswordBaru1';
  await form.fire('submit');
  await wait(60);
  const upd = calls.fn.filter((c) => c.action === 'update');
  assert.deepStrictEqual(upd[0], { action: 'update', id: 'u9', display_name: 'Budi B', role: 'admin', disabled: true, password: 'PasswordBaru1' },
    'hanya kolom yang berubah yang dikirim (email tidak ikut)');

  // ---- ubah akun sendiri: peran & status terkunci
  await editBtns()[0].fire('click');
  form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  assert.ok('disabled' in input(form, 'role').attrs && 'disabled' in input(form, 'active').attrs, 'peran dan status akun sendiri terkunci');
  assert.ok(byId.dlg.textContent.includes('tidak bisa mengubah peran'));
  input(form, 'display_name').value = 'Paul W';
  await form.fire('submit');
  await wait(60);
  assert.deepStrictEqual(calls.fn.filter((c) => c.action === 'update')[1], { action: 'update', id: 'u1', display_name: 'Paul W' });

  // ---- aktifkan kembali akun yang nonaktif (baris ke-3)
  await editBtns()[2].fire('click');
  form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  assert.ok(!('checked' in input(form, 'active').attrs), 'akun nonaktif: kotak aktif kosong');
  check(input(form, 'active'));
  await form.fire('submit');
  await wait(60);
  assert.deepStrictEqual(calls.fn.filter((c) => c.action === 'update')[2], { action: 'update', id: 'u7', disabled: false });

  // ---- galat dari server ditampilkan di form, dialog tetap terbuka
  env = makeEnv('admin', '#view=users', { fnError: 'Email sudah terdaftar' });
  await wait(80);
  await btn(env.byId.toolbar, '+ Tambah pengguna').fire('click');
  form = find(env.byId.dlg, (e) => e.tagName === 'FORM')[0];
  input(form, 'email').value = 'a@b.c';
  input(form, 'password').value = 'Rahasia123';
  await form.fire('submit');
  await wait(40);
  assert.ok(formErr(env.byId.dlg).includes('Email sudah terdaftar'));
  assert.ok(env.byId.dlg.open, 'dialog tetap terbuka saat gagal');

  // ---- galat dari platform Supabase: tampilkan pesan aslinya + kode HTTP + petunjuk (bukan pesan umum)
  env = makeEnv('admin', '#view=users', { platformError: { status: 401, body: { code: 401, message: 'Invalid JWT' } } });
  await wait(80);
  t = env.byId.main.textContent;
  assert.ok(t.includes('Invalid JWT (HTTP 401)'), t.slice(0, 200));
  assert.ok(!t.includes('non-2xx'), 'pesan umum yang tidak informatif tidak ditampilkan');
  assert.ok(t.includes('Verify JWT') && t.includes('--no-verify-jwt'), 'petunjuk untuk galat 401 JWT');
  env = makeEnv('admin', '#view=users', { platformError: { status: 503, body: { code: 'BOOT_ERROR', message: 'Function failed to start (please check logs)' } } });
  await wait(80);
  t = env.byId.main.textContent;
  assert.ok(t.includes('Function failed to start (please check logs) (HTTP 503)') && t.includes('Logs'), t.slice(0, 200));
  env = makeEnv('admin', '#view=users', { platformError: { status: 500, body: 'bukan json' } });
  await wait(80);
  assert.ok(env.byId.main.textContent.includes('(HTTP 500)'), 'isi bukan JSON tetap menampilkan kode HTTP');

  // ---- galat izin database (service_role tanpa GRANT): pesan asli + petunjuk SQL
  env = makeEnv('admin', '#view=users', { platformError: { status: 500, body: { error: 'Gagal membaca peran admin: permission denied for table profiles. Jalankan GRANT untuk service_role.' } } });
  await wait(80);
  t = env.byId.main.textContent;
  assert.ok(t.includes('permission denied for table profiles'), t.slice(0, 200));
  assert.ok(t.includes('grant select, insert, update, delete on public.profiles') && t.includes('to service_role;'), 'petunjuk SQL ditampilkan');
  assert.ok(!t.includes('Logs'), 'petunjuk yang lebih spesifik didahulukan');

  // ---- fungsi belum di-deploy -> petunjuk
  env = makeEnv('admin', '#view=users', { usersFnMissing: true });
  await wait(80);
  assert.ok(env.byId.main.textContent.includes('admin-users') && env.byId.main.textContent.includes('belum dipasang'));

  // ---- pengguna biasa tidak bisa membuka halaman ini
  env = makeEnv('user', '#view=users');
  await wait(80);
  assert.ok(find(env.byId.main, (e) => e.className.startsWith('entry')).length > 0);
  assert.ok(!env.byId.main.textContent.includes('x@y.z'));
  assert.strictEqual(env.calls.fn.length, 0, 'pengguna biasa tidak memanggil fungsi admin');
}

async function scenarioChangePassword() {
  const { byId, calls } = makeEnv('user');
  await wait(80);
  await btn(byId.userbox, 'Ganti password').fire('click');
  const form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  assert.ok(form && byId.dlg.textContent.includes('Ganti Password'));
  input(form, 'new_password').value = 'pendek';
  input(form, 'confirm_password').value = 'pendek';
  await form.fire('submit');
  assert.ok(formErr(byId.dlg).includes('minimal 8'));
  input(form, 'new_password').value = 'PasswordBaru1';
  input(form, 'confirm_password').value = 'PasswordLain2';
  await form.fire('submit');
  assert.ok(formErr(byId.dlg).includes('tidak sama'));
  assert.strictEqual(calls.auth.length, 0);
  input(form, 'confirm_password').value = 'PasswordBaru1';
  await form.fire('submit');
  await wait(30);
  assert.deepStrictEqual(calls.auth[0], { password: 'PasswordBaru1' });
  assert.ok(!byId.dlg.open && byId.msg.textContent.includes('Password diperbarui'));
}


(async () => {
  await scenarioUser();
  await scenarioUserCannotOpenAdmin();
  await scenarioAdmin();
  await scenarioMenuAndCalendar();
  await scenarioRooms();
  await scenarioReport();
  await scenarioUsers();
  await scenarioChangePassword();
  console.log('smoke.test.js: semua tes lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
