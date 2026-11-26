# SIMERU di GitHub Pages + Supabase

Versi baru SIMERU (jadwal ruangan): **web statis** di github.io, **Supabase** untuk database, login, dan push update realtime. Tidak ada server PHP.

```
web/                       -> situs statis (index.html, app.js, lib.js, style.css, config.js)
supabase/schema.sql        -> tabel, aturan keamanan (RLS), anti-bentrok, fungsi buat jadwal, realtime
supabase/functions/feed/   -> feed RSS/JSON (pengganti rss.php)
tools/mrbs_to_supabase.py  -> pindahkan data lama dari MySQL MRBS
tests/                     -> uji otomatis (sh tests/run-all.sh)
.github/workflows/pages.yml-> deploy otomatis ke GitHub Pages
```

## Fitur yang sudah ada
- Tampilan **Grid** per area (kolom = ruangan, baris = slot waktu, garis waktu "sekarang") dan tampilan **Daftar** harian.
- **Tambah / ubah / hapus** jadwal: banyak ruangan sekaligus, tipe Internal/External, status tentatif, **pilihan warna per jadwal**, jadwal **berulang** (harian/mingguan/bulanan/tahunan) dengan opsi lewati bentrok, hapus satu atau "ini dan seterusnya".
- **Anti-bentrok dijaga database** (exclusion constraint), jadi dua orang tidak mungkin memesan ruangan yang sama pada jam yang sama, walau menyimpan bersamaan.
- **Push update realtime** (Supabase Realtime): perubahan muncul di semua browser tanpa refresh.
- **Login** (Supabase Auth). Siapa saja boleh melihat jadwal; hanya pengguna login yang boleh menambah; ubah/hapus hanya oleh pembuat atau admin.
- **Feed RSS dan JSON** lewat Edge Function.
- Alamat bisa dibagikan, misalnya `.../#view=list&date=2026-11-26&area=1`.

## Yang BELUM ada dibanding MRBS lama
Tampilan Minggu dan Bulan, alur approval, email notifikasi/pengingat, halaman admin area/ruangan/pengguna (sementara lewat **Table Editor** Supabase), pencarian dan laporan, ubah seluruh seri sekaligus, import akun pengguna lama.

## Pasang, langkah demi langkah

### 1. Supabase
1. Buat proyek di <https://supabase.com> (pilih region terdekat, mis. Singapore).
2. **SQL Editor** -> tempel isi `supabase/schema.sql` -> **Run**.
3. **Authentication > Providers > Email**: matikan *Allow new users to sign up* (disarankan). Buat akun lewat **Authentication > Users > Add user** (centang *Auto Confirm*).
4. Jadikan diri Anda admin (SQL Editor):
   ```sql
   update public.profiles set role = 'admin'
    where id = (select id from auth.users where email = 'email-anda@contoh.ac.id');
   ```
5. Isi area dan ruangan lewat **Table Editor** (tabel `areas`, lalu `rooms`), atau pakai contoh di bagian 6 `schema.sql`. Kolom `start_hour`/`end_hour`/`slot_minutes` mengatur rentang jam dan ukuran slot grid.

### 2. Konfigurasi web
Salin dari **Project Settings > API** ke `web/config.js`: `SUPABASE_URL` dan `SUPABASE_ANON_KEY`.
> `anon key` memang dirancang tampil publik; keamanan datanya ada di aturan RLS pada `schema.sql`. **Jangan pernah** menaruh `service_role` key di repo atau `config.js`.

### 3. GitHub Pages
1. Buat repo, push seluruh folder ini ke branch `main`.
2. **Settings > Pages > Build and deployment > Source: GitHub Actions**. Workflow akan menjalankan uji lalu men-deploy folder `web/`.
3. Di Supabase **Authentication > URL Configuration**, isi *Site URL* dengan alamat Pages Anda (`https://<user>.github.io/<repo>/`).

### 4. Feed RSS/JSON (opsional)
```bash
npm i -g supabase            # atau lihat dokumentasi Supabase CLI
supabase login
supabase link --project-ref <project-ref>
supabase secrets set SITE_URL=https://<user>.github.io/<repo>/
supabase functions deploy feed --no-verify-jwt
```
Hasil: `https://<project-ref>.supabase.co/functions/v1/feed` (RSS) dan `...?format=json`. Isi alamat itu di `FEED_URL` pada `web/config.js` agar tautan muncul di tampilan Daftar.

### 5. Pindahkan data lama dari MRBS (opsional)
```bash
pip install pymysql
python tools/mrbs_to_supabase.py --host localhost --user root --database mrbsnew --out sql_out
# opsional: --from-date 2025-01-01  (hanya jadwal terbaru, jauh lebih ringan)
psql "<connection string Supabase>" -f sql_out/01_areas_rooms.sql
psql "<...>" -f sql_out/02_entries_0001.sql       # ulangi untuk tiap file 02_*
psql "<...>" -f sql_out/03_finish.sql
```
Connection string ada di Supabase **Connect** (pakai *Session pooler*). Skrip melaporkan jadwal yang dilewati; jadwal lama yang bertabrakan di ruangan yang sama dilewati oleh database. Jadwal hasil impor belum terhubung ke akun, jadi hanya admin yang dapat mengubahnya.

## Keamanan: periksa sebelum dipakai
- **Data jadwal terbaca publik** (nama acara, deskripsi, nama pembuat) oleh siapa pun yang tahu alamat situs. Itu sama dengan tampilan publik MRBS. Jika tidak boleh, ubah policy `entries_read` menjadi `to authenticated` (petunjuk di `schema.sql`); konsekuensinya feed dan layar tanpa login ikut berhenti.
- Repo GitHub Pages bersifat publik pada akun gratis; pastikan tidak ada rahasia di dalamnya.
- Batasi pendaftaran (langkah 1.3, atau trigger domain email di bagian 8 `schema.sql`).
- Data kampus akan berada di server Supabase (cloud pihak ketiga). Pastikan sesuai kebijakan fakultas/universitas.
- Cek batas paket gratis di halaman harga Supabase, termasuk **penghentian otomatis proyek yang tidak aktif** dan batas koneksi Realtime. Proyek yang dipakai harian umumnya aman, tetapi cadangkan data secara berkala.

## Status pengujian
Uji otomatis lulus (`sh tests/run-all.sh`): fungsi tanggal/zona waktu/warna/tata letak, alur aplikasi (render grid, warna kustom, hak ubah/hapus, simpan lewat RPC, tampilan daftar) memakai DOM dan klien Supabase tiruan, Edge Function feed, dan konversi data migrasi.
**Belum diuji terhadap proyek Supabase yang sebenarnya**: `schema.sql` (terutama fungsi `create_booking`, RLS, realtime) dan Edge Function belum dijalankan di PostgreSQL/Deno asli. Uji dulu di proyek Supabase percobaan: buat jadwal, jadwal berulang, jadwal bentrok, ubah, hapus, lalu coba dari dua browser untuk memastikan update realtime.
