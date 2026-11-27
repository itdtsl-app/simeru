// Jalankan: node tests/lib.test.js
const assert = require('assert');
const L = require('../web/lib.js');
const OFF = '+07:00';

// --- tanggal
assert.strictEqual(L.addDays('2026-11-30', 1), '2026-12-01');
assert.strictEqual(L.addDays('2026-12-31', 1), '2027-01-01');
assert.strictEqual(L.addDays('2028-03-01', -1), '2028-02-29');         // tahun kabisat
assert.strictEqual(L.parseDate('2026-02-30'), null);
assert.strictEqual(L.parseDate('26-11-2026'), null);
assert.strictEqual(L.longDate('2026-11-26'), 'Kamis, 26 November 2026');

// --- zona waktu tetap +07:00
assert.strictEqual(L.offsetMinutes('+07:00'), 420);
assert.strictEqual(L.offsetMinutes('-03:30'), -210);
assert.strictEqual(new Date(L.dayStartMs('2026-11-26', OFF)).toISOString(), '2026-11-25T17:00:00.000Z');
assert.strictEqual(L.toIso('2026-11-26', '08:30', OFF), '2026-11-26T08:30:00+07:00');
const ms = Date.parse('2026-11-26T08:30:00+07:00');
assert.strictEqual(L.msToTime(ms, OFF), '08:30');
assert.strictEqual(L.msToDate(ms, OFF), '2026-11-26');
// 23:30 UTC tanggal 25 = 06:30 WIB tanggal 26
assert.strictEqual(L.todayStr(OFF, Date.parse('2026-11-25T23:30:00Z')), '2026-11-26');
assert.strictEqual(L.todayStr(OFF, Date.parse('2026-11-25T16:59:00Z')), '2026-11-25');

// --- warna
assert.strictEqual(L.sanitizeColor('#FF9999'), '#ff9999');
assert.strictEqual(L.sanitizeColor('red'), null);
assert.strictEqual(L.sanitizeColor('#12345'), null);
assert.strictEqual(L.sanitizeColor(null), null);
assert.strictEqual(L.contrastText('#000000'), '#ffffff');
assert.strictEqual(L.contrastText('#ffe066'), '#0B263B');
assert.strictEqual(L.entryColor({ type: 'I', color: null }), '#99cc66');
assert.strictEqual(L.entryColor({ type: 'E', color: null }), '#6dd9c4');
assert.strictEqual(L.entryColor({ type: 'I', color: '#80BFFF' }), '#80bfff');
assert.strictEqual(L.entryColor({ type: 'I', color: 'javascript:1' }), '#99cc66');

// --- tata letak: area 07:00-19:00, slot 30 menit, 22px per slot
const area = { start_hour: 7, end_hour: 19, slot_minutes: 30 };
const ppm = 22 / 30;
const day = L.dayStartMs('2026-11-26', OFF);
const gs = day + 7 * 3600000, ge = day + 19 * 3600000;
assert.strictEqual(L.slotCount(area), 24);
let r = L.layout(day + 8.5 * 3600000, day + 11 * 3600000, gs, ge, ppm);   // 08:30-11:00
assert.ok(Math.abs(r.top - 3 * 22) < 1e-9);                                // 3 slot dari 07:00
assert.ok(Math.abs(r.height - 5 * 22) < 1e-9);
r = L.layout(day + 5 * 3600000, day + 8 * 3600000, gs, ge, ppm);          // mulai sebelum grid
assert.strictEqual(r.top, 0);
assert.ok(r.clippedTop && !r.clippedBottom);
assert.ok(Math.abs(r.height - 60 * ppm) < 1e-9);   // 07:00-08:00 = 1 jam
assert.strictEqual(L.layout(day + 1 * 3600000, day + 2 * 3600000, gs, ge, ppm), null);   // di luar grid
assert.strictEqual(L.layout(day + 19 * 3600000, day + 20 * 3600000, gs, ge, ppm), null);
// klik di kolom
assert.strictEqual(L.minutesFromOffset(0, 22, area), 7 * 60);
assert.strictEqual(L.minutesFromOffset(22 * 3 + 5, 22, area), 8 * 60 + 30);
assert.strictEqual(L.minutesFromOffset(99999, 22, area), 18 * 60 + 30);   // slot terakhir
assert.strictEqual(L.minutesToTime(8 * 60 + 30), '08:30');

// --- kalender mini (Nov 2026 mulai hari Minggu, Okt 2026 mulai hari Kamis, sesuai tampilan MRBS)
let w = L.monthMatrix(2026, 11);
assert.deepStrictEqual(w[0], [1, 2, 3, 4, 5, 6, 7]);
assert.deepStrictEqual(w[4], [29, 30, null, null, null, null, null]);
assert.strictEqual(w.length, 5);
w = L.monthMatrix(2026, 10);
assert.deepStrictEqual(w[0], [null, null, null, null, 1, 2, 3]);
assert.deepStrictEqual(w[4], [25, 26, 27, 28, 29, 30, 31]);
assert.strictEqual(L.monthMatrix(2026, 2).length, 4);                 // Feb 2026: tepat 4 minggu
assert.strictEqual(L.monthMatrix(2028, 2).flat().filter(Boolean).length, 29);   // kabisat
assert.strictEqual(L.monthTitle(2026, 11), 'November 2026');
assert.strictEqual(L.firstOfMonth('2026-11-27'), '2026-11-01');
assert.strictEqual(L.lastOfMonth('2026-11-27'), '2026-11-30');
assert.strictEqual(L.lastOfMonth('2028-02-10'), '2028-02-29');
assert.strictEqual(L.shiftMonth('2026-01-31', 1), '2026-02-28');      // dibatasi akhir bulan
assert.strictEqual(L.shiftMonth('2026-11-27', 1), '2026-12-27');
assert.strictEqual(L.shiftMonth('2026-01-15', -1), '2025-12-15');
assert.strictEqual(L.shiftMonth('2026-12-15', 2), '2027-02-15');

// --- pencarian
assert.strictEqual(L.escapeLike('100%_a\\b'), '100\\%\\_a\\\\b');

// --- laporan
const f = Date.parse('2026-11-01T00:00:00+07:00'), t2 = Date.parse('2026-12-01T00:00:00+07:00');
assert.strictEqual(L.clippedMinutes(Date.parse('2026-11-05T08:00:00+07:00'), Date.parse('2026-11-05T10:30:00+07:00'), f, t2), 150);
assert.strictEqual(L.clippedMinutes(Date.parse('2026-10-31T22:00:00+07:00'), Date.parse('2026-11-01T02:00:00+07:00'), f, t2), 120);   // dipotong awal
assert.strictEqual(L.clippedMinutes(Date.parse('2026-11-30T23:00:00+07:00'), Date.parse('2026-12-01T05:00:00+07:00'), f, t2), 60);    // dipotong akhir
assert.strictEqual(L.clippedMinutes(Date.parse('2026-12-02T08:00:00+07:00'), Date.parse('2026-12-02T09:00:00+07:00'), f, t2), 0);
assert.strictEqual(L.formatHours(150), '2,5');
assert.strictEqual(L.formatHours(0), '0,0');
const sum = L.summarizeByRoom([
  { room_id: 2, room_name: 'B', area_name: 'Z', start_time: '2026-11-05T01:00:00Z', end_time: '2026-11-05T03:00:00Z' },
  { room_id: 1, room_name: 'A', area_name: 'Z', start_time: '2026-11-06T01:00:00Z', end_time: '2026-11-06T02:00:00Z' },
  { room_id: 1, room_name: 'A', area_name: 'Z', start_time: '2026-11-07T01:00:00Z', end_time: '2026-11-07T02:30:00Z' },
  { room_id: 3, room_name: 'C', area_name: 'A', start_time: '2026-11-08T01:00:00Z', end_time: '2026-11-08T02:00:00Z' }
], f, t2);
assert.deepStrictEqual(sum.map((r) => [r.area_name, r.room_name, r.count, r.minutes]),
  [['A', 'C', 1, 60], ['Z', 'A', 2, 150], ['Z', 'B', 1, 120]]);        // urut area lalu ruangan

// --- CSV
assert.strictEqual(L.csvCell('biasa'), 'biasa');
assert.strictEqual(L.csvCell('a;b'), '"a;b"');
assert.strictEqual(L.csvCell('kata "kutip"'), '"kata ""kutip"""');
assert.strictEqual(L.csvCell('baris1\nbaris2'), '"baris1\nbaris2"');
assert.strictEqual(L.csvCell(null), '');
assert.strictEqual(L.csvCell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');   // formula dinetralkan
assert.strictEqual(L.csvCell('+62812'), "'+62812");
assert.strictEqual(L.csvCell('2026-11-27'), '2026-11-27');                                // tanggal tidak diubah
assert.strictEqual(L.csvLine(['a', 'b;c', 3]), 'a;"b;c";3');

console.log('lib.test.js: semua tes lulus');
