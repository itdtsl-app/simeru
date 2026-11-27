// Menguji supabase/functions/feed/index.ts di Node (>=22.6) dengan klien Supabase tiruan.
// Jalankan: node --experimental-strip-types tests/feed.test.mjs   (atau lewat tests/run-all.sh)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = fs.readFileSync(new URL('../supabase/functions/feed/index.ts', import.meta.url), 'utf8')
  .replace(/^import \{ createClient \}.*$/m, 'const createClient = globalThis.__createClient;');
const tmp = path.join(os.tmpdir(), 'feed_under_test.ts');
fs.writeFileSync(tmp, src);

const rows = [
  { id: 7, name: 'Rapat <Koordinasi> & Evaluasi', description: 'baris 1\nbaris 2 ]]> akhir', type: 'I', color: null, tentative: false,
    start_time: '2026-11-26T01:30:00+00:00', end_time: '2026-11-26T04:00:00+00:00',   // 08:30-11:00 WIB
    room_id: 10, room_name: 'Ruang Sidang Lantai 2', area_id: 1, area_name: 'Ruang Pertemuan', created_by_name: 'paul' },
  { id: 8, name: 'Lintas hari', description: null, type: 'E', color: '#ff9999', tentative: true,
    start_time: '2026-11-26T15:00:00+00:00', end_time: '2026-11-27T03:00:00+00:00',   // 22:00 WIB -> besok 10:00
    room_id: 11, room_name: 'Ruang B', area_id: 1, area_name: 'Ruang Pertemuan', created_by_name: null }
];
let lastFilters = [];
globalThis.__createClient = () => ({
  from() {
    const q = {
      select() { return q; }, lt(c, v) { lastFilters.push(['lt', c, v]); return q; }, gt(c, v) { lastFilters.push(['gt', c, v]); return q; },
      order() { return q; }, limit() { return q; }, eq(c, v) { lastFilters.push(['eq', c, v]); return q; },
      then: (ok, ko) => Promise.resolve({ data: rows, error: null }).then(ok, ko)
    };
    return q;
  }
});
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k', SITE_URL: 'https://user.github.io/simeru' })[k] },
  serve() {}
};

const { handler } = await import(pathToFileURL(tmp).href);

// --- JSON
let res = await handler(new Request('https://x/feed?format=json&date=2026-11-26&area=1'));
assert.strictEqual(res.status, 200);
assert.match(res.headers.get('content-type'), /application\/json/);
let j = await res.json();
assert.strictEqual(j.date, '2026-11-26');
assert.strictEqual(j.title, 'SIMERU DTSL - Jadwal Acara 2026-11-26');
assert.strictEqual(j.count, 2);
assert.strictEqual(j.events[0].start_time, '08:30');
assert.strictEqual(j.events[0].end_time, '11:00');
assert.strictEqual(j.events[1].start_time, '22:00');
assert.strictEqual(j.events[1].end_time, '24:00');           // dipotong ke akhir hari
assert.strictEqual(j.events[1].color, '#ff9999');
assert.strictEqual(j.events[0].url, 'https://user.github.io/simeru/#view=list&date=2026-11-26&area=1');
// rentang hari dan filter area dikirim ke database
assert.ok(lastFilters.some(([op, c, v]) => op === 'lt' && c === 'start_time' && v === '2026-11-27T00:00:00+07:00'));
assert.ok(lastFilters.some(([op, c, v]) => op === 'gt' && c === 'end_time' && v === '2026-11-26T00:00:00+07:00'));
assert.ok(lastFilters.some(([op, c, v]) => op === 'eq' && c === 'area_id' && v === 1));

// --- RSS
res = await handler(new Request('https://x/feed?date=2026-11-26'));
assert.match(res.headers.get('content-type'), /application\/rss\+xml/);
const xml = await res.text();
assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
assert.ok(xml.includes('<title>08:30-11:00  Rapat &lt;Koordinasi&gt; &amp; Evaluasi  @ Ruang Sidang Lantai 2</title>'));
assert.ok(xml.includes('(Tentatif)'));
assert.strictEqual((xml.match(/<item>/g) || []).length, 2);
assert.ok(xml.includes(']]&gt;'), 'deskripsi di-escape');
assert.strictEqual((xml.match(/\]\]>/g) || []).length, 2, 'hanya penutup CDATA asli (satu per item) yang berisi "]]>"');
assert.ok(!xml.includes('<Koordinasi>'), 'karakter < di judul di-escape');

// tanggal tidak valid -> memakai hari ini, bukan error
res = await handler(new Request('https://x/feed?format=json&date=2026-02-30'));
assert.strictEqual(res.status, 200);
// CORS preflight
res = await handler(new Request('https://x/feed', { method: 'OPTIONS' }));
assert.strictEqual(res.status, 204);

console.log('feed.test.mjs: semua tes lulus');
