// Isi dua nilai di bawah dari: Supabase > Project Settings > API
//  - Project URL
//  - anon / public key   (BOLEH tampil publik. JANGAN PERNAH memasukkan service_role key di sini!)
window.SIMERU_CONFIG = {
  SUPABASE_URL: 'https://safaehrhxfjwyqazccjh.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_iU2ONWQuQWQd4Bqata4gJg_Znd9T6wL',

  APP_TITLE: 'SIMERU',
  TIMEZONE: 'Asia/Jakarta',     // dipakai fungsi database untuk jadwal berulang
  TZ_OFFSET: '+07:00',          // WIB. (WITA +08:00, WIT +09:00)
  ALLOW_SIGNUP: false,          // true = tombol "Daftar" di form login (sebaiknya false, buat akun lewat dashboard)
  FEED_URL: ''                  // mis. https://<project>.supabase.co/functions/v1/feed  (opsional)
};
