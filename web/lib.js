// Fungsi bantu murni (tanpa DOM) untuk SIMERU. Diuji di tests/lib.test.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SimeruLib = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Warna bawaan tiap Type (sama dengan tema MRBS)
  var TYPE_COLORS = { I: '#99cc66', E: '#6dd9c4' };
  var TYPE_LABELS = { I: 'Internal', E: 'External' };

  // Pilihan warna cepat di form
  var PALETTE = [
    ['#ff9999', 'Merah'], ['#ffb366', 'Oranye'], ['#ffe066', 'Kuning'], ['#99cc66', 'Hijau'],
    ['#66d9c4', 'Tosca'], ['#80bfff', 'Biru'], ['#b399ff', 'Ungu'], ['#ff99cc', 'Pink'],
    ['#c9b79c', 'Coklat'], ['#c0c0c0', 'Abu-abu']
  ];

  var DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  var MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
                'September', 'Oktober', 'November', 'Desember'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 'YYYY-MM-DD' -> Date (UTC tengah malam) atau null bila tidak valid
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) { return null; }
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) { return null; }
    return dt;
  }

  function fmtDate(dt) {
    return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }

  function addDays(s, n) {
    var dt = parseDate(s);
    dt.setUTCDate(dt.getUTCDate() + n);
    return fmtDate(dt);
  }

  // '+07:00' -> 420 (menit)
  function offsetMinutes(off) {
    var m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
    if (!m) { throw new Error('Format offset salah: ' + off); }
    return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  }

  // tanggal hari ini di zona waktu dengan offset tetap
  function todayStr(off, nowMs) {
    var t = (nowMs === undefined ? Date.now() : nowMs) + offsetMinutes(off) * 60000;
    return fmtDate(new Date(t));
  }

  // epoch ms untuk jam 00:00 pada tanggal tersebut di zona waktu dengan offset
  function dayStartMs(dateStr, off) {
    return parseDate(dateStr).getTime() - offsetMinutes(off) * 60000;
  }

  // ('2026-11-26', '08:30', '+07:00') -> '2026-11-26T08:30:00+07:00'
  function toIso(dateStr, timeStr, off) {
    return dateStr + 'T' + timeStr + ':00' + off;
  }

  function msToTime(ms, off) {
    var t = new Date(ms + offsetMinutes(off) * 60000);
    return pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes());
  }

  function msToDate(ms, off) {
    return fmtDate(new Date(ms + offsetMinutes(off) * 60000));
  }

  function minutesToTime(min) {
    return pad(Math.floor(min / 60)) + ':' + pad(min % 60);
  }

  function longDate(s) {
    var dt = parseDate(s);
    return DAYS[dt.getUTCDay()] + ', ' + dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
  }

  function shortDate(s) {
    var dt = parseDate(s);
    return dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()].slice(0, 3) + ' ' + dt.getUTCFullYear();
  }

  // '#RRGGBB' valid -> huruf kecil, selain itu null
  function sanitizeColor(c) {
    if (typeof c !== 'string') { return null; }
    c = c.trim();
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null;
  }

  // warna teks (putih/gelap) yang terbaca di atas warna latar
  function contrastText(hex) {
    hex = sanitizeColor(hex);
    if (!hex) { return '#0B263B'; }
    var r = parseInt(hex.substr(1, 2), 16), g = parseInt(hex.substr(3, 2), 16), b = parseInt(hex.substr(5, 2), 16);
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.5 ? '#ffffff' : '#0B263B';
  }

  function entryColor(entry) {
    return sanitizeColor(entry.color) || TYPE_COLORS[entry.type] || TYPE_COLORS.I;
  }

  // Posisi blok jadwal di dalam kolom ruangan (dipotong ke batas grid). null bila di luar grid.
  function layout(startMs, endMs, gridStartMs, gridEndMs, pxPerMin) {
    var s = Math.max(startMs, gridStartMs);
    var e = Math.min(endMs, gridEndMs);
    if (e <= s) { return null; }
    return {
      top: (s - gridStartMs) / 60000 * pxPerMin,
      height: (e - s) / 60000 * pxPerMin,
      clippedTop: startMs < gridStartMs,
      clippedBottom: endMs > gridEndMs
    };
  }

  // jumlah baris slot dalam grid
  function slotCount(area) {
    return Math.round((area.end_hour - area.start_hour) * 60 / area.slot_minutes);
  }

  // offset piksel di kolom -> menit sejak 00:00 (dibulatkan ke bawah per slot)
  function minutesFromOffset(y, rowPx, area) {
    var idx = Math.max(0, Math.min(slotCount(area) - 1, Math.floor(y / rowPx)));
    return area.start_hour * 60 + idx * area.slot_minutes;
  }

  return {
    TYPE_COLORS: TYPE_COLORS, TYPE_LABELS: TYPE_LABELS, PALETTE: PALETTE,
    pad: pad, parseDate: parseDate, fmtDate: fmtDate, addDays: addDays,
    offsetMinutes: offsetMinutes, todayStr: todayStr, dayStartMs: dayStartMs, toIso: toIso,
    msToTime: msToTime, msToDate: msToDate, minutesToTime: minutesToTime,
    longDate: longDate, shortDate: shortDate,
    sanitizeColor: sanitizeColor, contrastText: contrastText, entryColor: entryColor,
    layout: layout, slotCount: slotCount, minutesFromOffset: minutesFromOffset
  };
});
