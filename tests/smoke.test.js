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
  append(...cs) { cs.forEach((c) => this.children.push(typeof c === 'string' ? new Txt(c) : c)); }
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

const byId = {};
['title', 'userbox', 'toolbar', 'msg', 'main', 'dlg'].forEach((id) => { byId[id] = new El(id === 'dlg' ? 'dialog' : 'div'); });
const document = {
  getElementById: (id) => byId[id] ||
    ['toolbar', 'main', 'dlg', 'userbox'].flatMap((k) => find(byId[k], (e) => e.attrs.id === id))[0] || null,
  createElement: (t) => new El(t), createTextNode: (t) => new Txt(t),
  addEventListener() {}, title: '', hidden: false
};

// ---------- Supabase tiruan ----------
const today = L.todayStr('+07:00');
const iso = (d, t) => L.toIso(d, t, '+07:00');
const DATA = {
  areas: [{ id: 1, name: 'Ruang Pertemuan dan Seminar', start_hour: 7, end_hour: 19, slot_minutes: 30, sort_order: 0, disabled: false }],
  rooms: [{ id: 10, area_id: 1, name: 'Ruang A', capacity: 6 }, { id: 11, area_id: 1, name: 'Ruang B', capacity: 10 }],
  entries: [
    { id: 1, room_id: 10, start_time: iso(today, '08:30'), end_time: iso(today, '11:00'), name: 'Rapat Koordinasi', description: 'tes', type: 'I', color: '#ff9999', tentative: false, created_by: 'u1', created_by_name: 'paul', series_id: null },
    { id: 2, room_id: 11, start_time: iso(today, '13:00'), end_time: iso(today, '14:30'), name: 'Kuliah', description: null, type: 'E', color: null, tentative: true, created_by: 'u2', created_by_name: 'lain', series_id: 'abc' }
  ],
  events: []
};
DATA.events = DATA.entries.map((e) => Object.assign({ room_name: 'Ruang', area_name: 'Area', area_id: 1 }, e));
const calls = { rpc: [], updates: [], deletes: [] };
function qb(table) {
  const q = {
    select() { return q; }, eq() { return q; }, in() { return q; }, lt() { return q; }, gt() { return q; },
    gte() { return q; }, order() { return q; },
    delete() { calls.deletes.push(table); return q; }, update(v) { calls.updates.push(v); return q; },
    maybeSingle: () => Promise.resolve({ data: { display_name: 'Paul', role: 'user' }, error: null }),
    then: (ok, ko) => Promise.resolve({ data: DATA[table] || [], error: null }).then(ok, ko)
  };
  return q;
}
const fakeSb = {
  from: qb,
  rpc: (name, args) => { calls.rpc.push({ name, args }); return Promise.resolve({ data: { created: 1, skipped: [] }, error: null }); },
  auth: {
    getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1', email: 'a@b.c' } } } }),
    onAuthStateChange() {}, signOut() {}, signInWithPassword: () => Promise.resolve({ error: null })
  },
  channel() { const c = { on() { return c; }, subscribe(cb) { cb('SUBSCRIBED'); return c; } }; return c; }
};

const sandbox = {
  document, console, Date, URLSearchParams, Promise, Object, Array, String, parseInt, Math, JSON, Number,
  setTimeout, clearTimeout, setInterval, setInterval_: setInterval,
  location: { hash: '' }, history: { replaceState() {} },
  SimeruLib: L
};
sandbox.window = sandbox;
sandbox.addEventListener = () => {};
sandbox.SIMERU_CONFIG = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', TZ_OFFSET: '+07:00', TIMEZONE: 'Asia/Jakarta' };
sandbox.supabase = { createClient: () => fakeSb };

(async () => {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8'), sandbox);
  await new Promise((r) => setTimeout(r, 80));

  // 1) grid hari: 2 ruangan, 2 jadwal
  const main = byId.main;
  const heads = find(main, (e) => e.className === 'rhead');
  assert.strictEqual(heads.length, 2, 'dua kolom ruangan');
  const blocks = find(main, (e) => e.className.startsWith('entry'));
  assert.strictEqual(blocks.length, 2, 'dua blok jadwal');
  const b1 = blocks[0];
  assert.strictEqual(b1.style.backgroundColor, '#ff9999', 'warna kustom dipakai');
  assert.strictEqual(b1.style.top, (3 * 22) + 'px');         // 08:30 = 3 slot dari 07:00
  assert.strictEqual(b1.style.height, (5 * 22 - 1) + 'px');  // 2,5 jam
  assert.strictEqual(blocks[1].style.backgroundColor, '#6dd9c4', 'tipe E bawaan tosca');
  assert.ok(blocks[1].className.includes('tentative'));
  assert.ok(byId.userbox.textContent.includes('Paul'), 'nama pengguna tampil');
  assert.ok(byId.toolbar.textContent.includes('Live'), 'indikator live');

  // 2) detail jadwal milik sendiri -> ada tombol Ubah & Hapus
  await b1.fire('click');
  assert.ok(byId.dlg.open);
  let btnTexts = find(byId.dlg, (e) => e.tagName === 'BUTTON').map((b) => b.textContent);
  assert.ok(btnTexts.includes('Ubah') && btnTexts.includes('Hapus'), 'pemilik boleh ubah/hapus: ' + btnTexts);
  // jadwal orang lain -> tidak ada tombol Ubah
  await blocks[1].fire('click');
  btnTexts = find(byId.dlg, (e) => e.tagName === 'BUTTON').map((b) => b.textContent);
  assert.ok(!btnTexts.includes('Ubah') && !btnTexts.includes('Hapus'), 'bukan pemilik tidak boleh ubah');

  // 3) tombol Tambah jadwal -> form -> simpan memanggil RPC dengan parameter benar
  const addBtn = find(byId.toolbar, (e) => e.tagName === 'BUTTON' && e.textContent.includes('Tambah'))[0];
  await addBtn.fire('click');
  const form = find(byId.dlg, (e) => e.tagName === 'FORM')[0];
  assert.ok(form, 'form terbuka');
  const inputs = find(form, (e) => e.tagName === 'INPUT');
  const nameIn = inputs.filter((i) => i.attrs.type === 'text')[0];
  nameIn.value = 'Rapat Uji';
  const swatches = find(form, (e) => e.className.startsWith('sw '));
  assert.strictEqual(swatches.length, 11, '1 default + 10 palet');
  await swatches[6].fire('click');                              // pilih warna ke-6 palet (Biru)
  await form.fire('submit');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(calls.rpc.length, 1, 'RPC create_booking dipanggil');
  const a = calls.rpc[0].args;
  assert.strictEqual(calls.rpc[0].name, 'create_booking');
  assert.deepStrictEqual(a.p_room_ids, [10]);
  assert.strictEqual(a.p_name, 'Rapat Uji');
  assert.strictEqual(a.p_color, '#80bfff');
  assert.strictEqual(a.p_start, iso(today, '07:00'));
  assert.strictEqual(a.p_end, iso(today, '08:00'));
  assert.strictEqual(a.p_repeat, 'none');
  assert.strictEqual(a.p_tz, 'Asia/Jakarta');
  assert.strictEqual(a.p_tentative, false);
  assert.ok(!byId.dlg.open, 'dialog tertutup setelah simpan');

  // 4) tampilan daftar
  const listBtn = find(byId.toolbar, (e) => e.tagName === 'BUTTON' && e.textContent === 'Daftar')[0];
  await listBtn.fire('click');
  await new Promise((r) => setTimeout(r, 30));
  const rows = find(byId.main, (e) => e.className === 'row');
  assert.strictEqual(rows.length, 2, 'dua baris di daftar');
  assert.ok(byId.main.textContent.includes('Rapat Koordinasi'));

  console.log('smoke.test.js: semua tes lulus');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
