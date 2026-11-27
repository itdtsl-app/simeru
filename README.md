# SIMERU DTSL di GitHub Pages + Supabase

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
- **Menu admin "Kelola Area & Ruang"** (tombol muncul di header untuk admin): tambah, ubah, nonaktifkan/aktifkan, dan hapus area serta ruangan; pindahkan ruangan ke area lain; atur jam grid dan ukuran slot per area. Menghapus menampilkan jumlah jadwal yang ikut terhapus dan meminta ketik HAPUS bila ada jadwalnya.
- **Menu atas bergaya MRBS**: Jadwal, Ruang, Laporan, kotak Cari, dan blok pengguna (nama, Masuk/Keluar, Daftar pengguna, Kelola Area & Ruang untuk admin).
- **Kalender 3 bulan** (bulan sebelumnya, terpilih, berikutnya) dengan hari ini berwarna merah muda dan tanggal terpilih ditandai; klik tanggal untuk pindah hari, panah untuk geser bulan. Di layar sempit hanya bulan terpilih yang tampil.
- **Ruang**: daftar area dan ruangan beserta kapasitas dan keterangan, dengan tautan ke jadwalnya.
- **Cari**: cari di judul, deskripsi, dan nama pembuat (default hanya acara yang belum lewat).
- **Laporan**: pilih rentang tanggal, area, dan ruangan; ringkasan jumlah acara dan total jam per ruangan; rincian; unduh **CSV** (pemisah titik koma, cocok untuk Excel berbahasa Indonesia; sel yang diawali `=`, `+`, `-`, `@` dinetralkan agar tidak dieksekusi sebagai rumus).
- **Daftar pengguna** (admin): lihat akun dan ubah peran admin/pengguna. Butuh `supabase/users.sql` (opsional, jalankan sekali di SQL Editor).
- **Feed RSS dan JSON** lewat Edge Function.
- Alamat bisa dibagikan, misalnya `.../#view=list&date=2026-11-26&area=1`.

## Yang BELUM ada dibanding MRBS lama
Tampilan Minggu dan Bulan, alur approval, email notifikasi/pengingat, pembuatan akun dari dalam aplikasi (akun baru tetap dibuat lewat **Authentication > Users** di Supabase), ubah seluruh seri sekaligus, import akun pengguna lama.

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
5. Setelah situs berjalan dan Anda login sebagai admin, klik **Kelola Area & Ruang** untuk menambah area dan ruangan. (Alternatif: Table Editor Supabase atau contoh di bagian 6 `schema.sql`.)

### 2. Konfigurasi web
Salin dari **Project Settings > API** ke `web/config.js`: `SUPABASE_URL` dan `SUPABASE_ANON_KEY`. Nama aplikasi diatur oleh `APP_TITLE` (default **SIMERU DTSL**).
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

## Jika muncul "Gagal terhubung ke Supabase: Anda tidak punya izin..." (error 42501)
Proyek Supabase baru tidak lagi memberi hak akses otomatis pada tabel baru. Jalankan blok **3b** dari `supabase/schema.sql` (bagian GRANT) di SQL Editor, lalu muat ulang halaman dengan Ctrl+F5.

## Keamanan: periksa sebelum dipakai
- **Data jadwal terbaca publik** (nama acara, deskripsi, nama pembuat) oleh siapa pun yang tahu alamat situs. Itu sama dengan tampilan publik MRBS. Jika tidak boleh, ubah policy `entries_read` menjadi `to authenticated` (petunjuk di `schema.sql`); konsekuensinya feed dan layar tanpa login ikut berhenti.
- Repo GitHub Pages bersifat publik pada akun gratis; pastikan tidak ada rahasia di dalamnya.
- Batasi pendaftaran (langkah 1.3, atau trigger domain email di bagian 8 `schema.sql`).
- Data kampus akan berada di server Supabase (cloud pihak ketiga). Pastikan sesuai kebijakan fakultas/universitas.
- Cek batas paket gratis di halaman harga Supabase, termasuk **penghentian otomatis proyek yang tidak aktif** dan batas koneksi Realtime. Proyek yang dipakai harian umumnya aman, tetapi cadangkan data secara berkala.

## Status pengujian
Uji otomatis lulus (`sh tests/run-all.sh`): fungsi tanggal/zona waktu/warna/tata letak, alur aplikasi (render grid, warna kustom, hak ubah/hapus, simpan lewat RPC, tampilan daftar) memakai DOM dan klien Supabase tiruan, Edge Function feed, dan konversi data migrasi.
**Belum diuji terhadap proyek Supabase yang sebenarnya**: `schema.sql` (terutama fungsi `create_booking`, RLS, realtime) dan Edge Function belum dijalankan di PostgreSQL/Deno asli. Uji dulu di proyek Supabase percobaan: buat jadwal, jadwal berulang, jadwal bentrok, ubah, hapus, lalu coba dari dua browser untuk memastikan update realtime.
