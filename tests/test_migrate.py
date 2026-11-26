"""Uji logika konversi tools/mrbs_to_supabase.py dengan data contoh (tanpa MySQL).
Jalankan: python3 tests/test_migrate.py"""
import os, sys, tempfile, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import mrbs_to_supabase as m

assert m.lit(None) == "NULL" and m.lit(True) == "true" and m.lit(5) == "5"
assert m.lit("O'Brien") == "'O''Brien'"                        # kutip di-escape
assert m.lit("a\\b") == "'a\\b'"                               # backslash apa adanya (standard_conforming_strings)
assert m.lit("x\x00y") == "'xy'"                               # karakter NUL dibuang

assert m.slot_minutes(1800) == 30 and m.slot_minutes(900) == 15 and m.slot_minutes(777) == 30 and m.slot_minutes(None) == 30
# MRBS 7:00 .. slot terakhir mulai 18:30 (resolusi 30 menit) -> grid sampai 19:00
assert m.area_hours({"morningstarts": 7, "eveningends": 18, "eveningends_minutes": 30, "resolution": 1800}) == (7, 19)
assert m.area_hours({"morningstarts": 7, "eveningends": 19, "eveningends_minutes": 0, "resolution": 1800}) == (7, 20)
assert m.area_hours({"morningstarts": 8, "eveningends": 23, "eveningends_minutes": 30, "resolution": 3600}) == (8, 24)  # dibatasi 24

areas = [{"id": 1, "area_name": "1. Ruang Pertemuan dan Seminar", "disabled": 0, "morningstarts": 7,
          "eveningends": 18, "eveningends_minutes": 30, "resolution": 1800}]
rooms = [{"id": 10, "area_id": 1, "room_name": "Ruang Rapat MPK", "sort_key": "b", "capacity": 10, "description": "", "disabled": 0},
         {"id": 11, "area_id": 1, "room_name": "Ruang Rapat AKD 1", "sort_key": "a", "capacity": None, "description": "Lt. 2", "disabled": 1}]
sql = m.areas_rooms_sql(areas, rooms)
assert sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;")
assert "(1, '1. Ruang Pertemuan dan Seminar', 0, 7, 19, 30, false)" in sql
assert "(11, 1, 'Ruang Rapat AKD 1', 0, NULL, 'Lt. 2', true)" in sql      # sort_key 'a' lebih dulu
assert "(10, 1, 'Ruang Rapat MPK', 1, 10, NULL, false)" in sql

room_ids = {10, 11}
base = {"id": 100, "room_id": 10, "start_time": 1795651200, "end_time": 1795654800, "name": " Rapat 'A' ",
        "description": "", "type": "I", "status": 0, "repeat_id": 0, "create_by": "paul"}
t, why = m.entry_tuple(base, room_ids, True)
assert why is None
assert t == "(100, 10, to_timestamp(1795651200), to_timestamp(1795654800), 'Rapat ''A''', NULL, 'I', NULL, false, NULL, 'paul')", t

r = dict(base, id=101, type="B", status=4, repeat_id=55, color="#FF9999", description="  catatan ")
t, why = m.entry_tuple(r, room_ids, True)
assert "'I', '#ff9999', true, '%s', 'paul')" % uuid.uuid5(m.SERIES_NS, "repeat-55") in t     # tipe B -> I, tentative, seri
assert "'catatan'" in t
t, _ = m.entry_tuple(dict(r, status=2, color="merah"), room_ids, True)
assert "NULL, true," in t                                                                      # warna tidak valid -> NULL, menunggu approval -> tentative
t, _ = m.entry_tuple(dict(r, color="#ff9999"), room_ids, False)
assert "'#ff9999'" not in t                                                                    # tanpa kolom color, abaikan
assert m.entry_tuple(dict(base, room_id=999), room_ids, False)[1] == "ruangan tidak ada"
assert m.entry_tuple(dict(base, end_time=base["start_time"]), room_ids, False)[1] == "waktu selesai <= mulai"
t, _ = m.entry_tuple(dict(base, name=None, create_by=None), room_ids, False)
assert "'(tanpa judul)'" in t and t.endswith("NULL)")

# --- tulis file: 5 baris valid + 2 dilewati, batch 2, 3 baris per file -> 2 file
rows = [dict(base, id=200 + i) for i in range(5)] + [dict(base, id=300, room_id=999), dict(base, id=301, end_time=1)]
with tempfile.TemporaryDirectory() as d:
    files, exported, skipped = m.write_entries(rows, room_ids, False, d, rows_per_file=3, batch=2)
    assert exported == 5 and len(files) == 2, (exported, files)
    assert skipped == {"ruangan tidak ada": 1, "waktu selesai <= mulai": 1}
    c1 = open(files[0], encoding="utf-8").read()
    c2 = open(files[1], encoding="utf-8").read()
    assert c1.startswith("BEGIN;") and c1.rstrip().endswith("COMMIT;")
    assert c1.count("INSERT INTO") == 2 and c2.count("INSERT INTO") == 1      # 3 baris = batch 2 + 1
    assert c1.count("ON CONFLICT DO NOTHING;") == 2
    assert c1.count("to_timestamp(1795651200)") == 3 and c2.count("to_timestamp(1795651200)") == 2
    assert os.path.basename(files[0]) == "02_entries_0001.sql" and os.path.basename(files[1]) == "02_entries_0002.sql"
print("test_migrate.py: semua tes lulus")
