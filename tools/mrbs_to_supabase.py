#!/usr/bin/env python3
"""
Ekspor data MRBS (MySQL) menjadi file SQL untuk Supabase (PostgreSQL).

Hasil (di folder --out):
  01_areas_rooms.sql      area dan ruangan
  02_entries_0001.sql ... jadwal (dipecah per --rows-per-file baris)
  03_finish.sql           menyetel ulang sequence ID + menampilkan jumlah data

Cara pakai:
  pip install pymysql
  python tools/mrbs_to_supabase.py --host localhost --user root --database mrbsnew --out sql_out
  (password: tambahkan --password, atau set variabel lingkungan MRBS_DB_PASSWORD)

Lalu impor berurutan ke Supabase. Untuk data besar (puluhan ribu baris) paling andal pakai psql:
  psql "<connection string dari Supabase > Connect>" -f sql_out/01_areas_rooms.sql
  psql "<...>" -f sql_out/02_entries_0001.sql   (ulangi untuk setiap file)
  psql "<...>" -f sql_out/03_finish.sql

Aturan konversi:
  * ID area/ruangan/jadwal dipertahankan.
  * status MRBS: bit 0x04 (tentative) dan 0x02 (menunggu approval) -> tentative = true.  Bit private diabaikan.
  * type selain 'I'/'E' dijadikan 'I' (tema ini hanya memakai I dan E).
  * repeat_id MRBS -> series_id (UUID deterministik, jadi jadwal berulang tetap satu seri).
  * create_by (nama pengguna MRBS) -> created_by_name. created_by (akun Supabase) dikosongkan,
    sehingga jadwal lama hanya bisa diubah/dihapus admin sampai Anda mengaitkannya ke akun.
  * kolom color (dari patch warna) ikut dibawa bila ada.
  * jadwal yang waktu selesainya <= mulai, atau ruangannya tidak ada, dilewati dan dilaporkan.
  * jadwal yang bertabrakan di ruangan yang sama dilewati oleh database (ON CONFLICT DO NOTHING);
    bandingkan jumlah di 03_finish.sql dengan jumlah yang dilaporkan skrip ini.
"""
import argparse
import datetime
import os
import re
import sys
import uuid

SERIES_NS = uuid.UUID("6f1d7a52-3b0e-4f0a-9d3a-5f1c1f0e2a11")
STATUS_AWAITING_APPROVAL = 0x02
STATUS_TENTATIVE = 0x04
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def lit(v):
    """Literal SQL (PostgreSQL, standard_conforming_strings = on)."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        v = v.decode("utf-8", "replace")
    s = str(v).replace("\x00", "").replace("'", "''")
    return "'" + s + "'"


def slot_minutes(resolution_seconds):
    m = int((resolution_seconds or 1800) // 60)
    return m if m in (5, 10, 15, 20, 30, 60) else 30


def area_hours(row):
    """(start_hour, end_hour) grid. end_hour = jam setelah slot terakhir, dibulatkan ke atas."""
    start_h = int(row.get("morningstarts") if row.get("morningstarts") is not None else 7)
    last_min = int(row.get("eveningends") if row.get("eveningends") is not None else 19) * 60 \
        + int(row.get("eveningends_minutes") or 0)
    end_min = last_min + slot_minutes(row.get("resolution"))
    end_h = min(24, -(-end_min // 60))
    if end_h <= start_h:
        end_h = min(24, start_h + 1)
    return start_h, end_h


def areas_rooms_sql(areas, rooms):
    out = ["BEGIN;"]
    for idx, a in enumerate(sorted(areas, key=lambda r: (str(r.get("area_name") or ""), r["id"]))):
        sh, eh = area_hours(a)
        out.append(
            "INSERT INTO public.areas (id, name, sort_order, start_hour, end_hour, slot_minutes, disabled) VALUES "
            f"({a['id']}, {lit(a.get('area_name') or '(tanpa nama)')}, {idx}, {sh}, {eh}, "
            f"{slot_minutes(a.get('resolution'))}, {lit(bool(a.get('disabled')))}) "
            "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, "
            "start_hour = EXCLUDED.start_hour, end_hour = EXCLUDED.end_hour, "
            "slot_minutes = EXCLUDED.slot_minutes, disabled = EXCLUDED.disabled;")
    ordered = sorted(rooms, key=lambda r: (str(r.get("sort_key") or ""), str(r.get("room_name") or ""), r["id"]))
    for idx, r in enumerate(ordered):
        cap = r.get("capacity")
        out.append(
            "INSERT INTO public.rooms (id, area_id, name, sort_order, capacity, description, disabled) VALUES "
            f"({r['id']}, {r['area_id']}, {lit(r.get('room_name') or '(tanpa nama)')}, {idx}, "
            f"{lit(int(cap) if cap not in (None, '') else None)}, {lit(r.get('description') or None)}, "
            f"{lit(bool(r.get('disabled')))}) "
            "ON CONFLICT (id) DO UPDATE SET area_id = EXCLUDED.area_id, name = EXCLUDED.name, "
            "sort_order = EXCLUDED.sort_order, capacity = EXCLUDED.capacity, "
            "description = EXCLUDED.description, disabled = EXCLUDED.disabled;")
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


def entry_tuple(r, room_ids, has_color):
    """Mengembalikan (tuple_sql, None) atau (None, alasan_dilewati)."""
    if r["room_id"] not in room_ids:
        return None, "ruangan tidak ada"
    start, end = int(r["start_time"]), int(r["end_time"])
    if end <= start:
        return None, "waktu selesai <= mulai"
    status = int(r.get("status") or 0)
    tentative = bool(status & (STATUS_TENTATIVE | STATUS_AWAITING_APPROVAL))
    typ = r.get("type") if r.get("type") in ("I", "E") else "I"
    color = None
    if has_color and isinstance(r.get("color"), str) and HEX_COLOR.match(r["color"].strip()):
        color = r["color"].strip().lower()
    rep = r.get("repeat_id")
    series = str(uuid.uuid5(SERIES_NS, "repeat-%s" % rep)) if rep else None
    name = (r.get("name") or "").strip() or "(tanpa judul)"
    return ("(%d, %d, to_timestamp(%d), to_timestamp(%d), %s, %s, %s, %s, %s, %s, %s)" % (
        r["id"], r["room_id"], start, end, lit(name), lit((r.get("description") or "").strip() or None),
        lit(typ), lit(color), lit(tentative), lit(series), lit(r.get("create_by") or None))), None


ENTRY_HEAD = ("INSERT INTO public.entries (id, room_id, start_time, end_time, name, description, type, color, "
              "tentative, series_id, created_by_name) VALUES\n")


def write_entries(rows, room_ids, has_color, out_dir, rows_per_file=10000, batch=500):
    files, skipped = [], {}
    exported = 0
    cur_file, cur_count, pending = None, 0, []

    def flush_pending():
        nonlocal pending
        if pending:
            cur_file.write(ENTRY_HEAD + ",\n".join(pending) + "\nON CONFLICT DO NOTHING;\n")
            pending = []

    def open_new():
        nonlocal cur_file, cur_count
        if cur_file:
            flush_pending()
            cur_file.write("COMMIT;\n")
            cur_file.close()
        path = os.path.join(out_dir, "02_entries_%04d.sql" % (len(files) + 1))
        files.append(path)
        cur_file = open(path, "w", encoding="utf-8")
        cur_file.write("BEGIN;\n")
        cur_count = 0

    for r in rows:
        tup, why = entry_tuple(r, room_ids, has_color)
        if tup is None:
            skipped[why] = skipped.get(why, 0) + 1
            continue
        if cur_file is None or cur_count >= rows_per_file:
            open_new()
        pending.append(tup)
        cur_count += 1
        exported += 1
        if len(pending) >= batch:
            flush_pending()
    if cur_file:
        flush_pending()
        cur_file.write("COMMIT;\n")
        cur_file.close()
    return files, exported, skipped


FINISH_SQL = """-- Setel ulang sequence agar ID baru tidak bentrok dengan ID hasil impor
SELECT setval(pg_get_serial_sequence('public.areas',   'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.areas), 1));
SELECT setval(pg_get_serial_sequence('public.rooms',   'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.rooms), 1));
SELECT setval(pg_get_serial_sequence('public.entries', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.entries), 1));

-- Bandingkan dengan jumlah yang dilaporkan skrip ekspor
SELECT (SELECT COUNT(*) FROM public.areas)   AS areas,
       (SELECT COUNT(*) FROM public.rooms)   AS rooms,
       (SELECT COUNT(*) FROM public.entries) AS entries;
"""


def main():
    ap = argparse.ArgumentParser(description="Ekspor MRBS (MySQL) -> SQL Supabase")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=3306)
    ap.add_argument("--user", default="root")
    ap.add_argument("--password", default=os.environ.get("MRBS_DB_PASSWORD", ""))
    ap.add_argument("--database", required=True)
    ap.add_argument("--prefix", default="mrbs_", help="awalan nama tabel MRBS (default mrbs_)")
    ap.add_argument("--out", default="sql_out")
    ap.add_argument("--from-date", help="hanya jadwal yang berakhir pada/setelah tanggal ini (YYYY-MM-DD)")
    ap.add_argument("--rows-per-file", type=int, default=10000)
    args = ap.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_]*", args.prefix):
        sys.exit("--prefix hanya boleh huruf, angka, dan underscore")
    try:
        import pymysql
        import pymysql.cursors
    except ImportError:
        sys.exit("Pasang dulu: pip install pymysql")

    os.makedirs(args.out, exist_ok=True)
    conn = pymysql.connect(host=args.host, port=args.port, user=args.user, password=args.password,
                           database=args.database, charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor)
    p = args.prefix
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM `%sarea`" % p)
        areas = cur.fetchall()
        cur.execute("SELECT * FROM `%sroom`" % p)
        rooms = cur.fetchall()
        cur.execute("SHOW COLUMNS FROM `%sentry` LIKE 'color'" % p)
        has_color = cur.fetchone() is not None

    with open(os.path.join(args.out, "01_areas_rooms.sql"), "w", encoding="utf-8") as f:
        f.write(areas_rooms_sql(areas, rooms))

    where, params = "", ()
    if args.from_date:
        d = datetime.datetime.strptime(args.from_date, "%Y-%m-%d").replace(
            tzinfo=datetime.timezone(datetime.timedelta(hours=7)))
        where, params = " WHERE end_time >= %s", (int(d.timestamp()),)
    cols = "id, room_id, start_time, end_time, name, description, type, status, repeat_id, create_by"
    if has_color:
        cols += ", color"
    stream = conn.cursor(pymysql.cursors.SSDictCursor)
    stream.execute("SELECT %s FROM `%sentry`%s ORDER BY id" % (cols, p, where), params)
    files, exported, skipped = write_entries(stream, {r["id"] for r in rooms}, has_color,
                                             args.out, args.rows_per_file)
    stream.close()
    with open(os.path.join(args.out, "03_finish.sql"), "w", encoding="utf-8") as f:
        f.write(FINISH_SQL)
    conn.close()

    print("Area      : %d" % len(areas))
    print("Ruangan   : %d" % len(rooms))
    print("Jadwal    : %d diekspor ke %d file" % (exported, len(files)))
    for why, n in skipped.items():
        print("  dilewati: %d (%s)" % (n, why))
    print("Kolom color ditemukan: %s" % ("ya" if has_color else "tidak"))
    print("Selesai. Impor 01 -> 02_* -> 03 ke Supabase (lihat petunjuk di kepala skrip).")


if __name__ == "__main__":
    main()
