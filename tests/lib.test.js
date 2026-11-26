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

console.log('lib.test.js: semua tes lulus');
