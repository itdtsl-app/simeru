// Menguji supabase/functions/admin-users/index.ts di Node (>=22.6) dengan klien Supabase tiruan.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = fs.readFileSync(new URL('../supabase/functions/admin-users/index.ts', import.meta.url), 'utf8')
  .replace(/^import \{ createClient \}.*$/m, 'const createClient = globalThis.__createClient;');
const tmp = path.join(os.tmpdir(), 'admin_users_under_test.ts');
fs.writeFileSync(tmp, src);

const A = '11111111-1111-4111-8111-111111111111';   // admin (pemanggil)
const U = '22222222-2222-4222-8222-222222222222';   // pengguna biasa
const B = '33333333-3333-4333-8333-333333333333';   // pengguna lain yang akan diubah
const NEW = '44444444-4444-4444-8444-444444444444';

const log = { createUser: [], updateUserById: [], upserts: [] };
const tokens = { 't-admin': { id: A }, 't-user': { id: U } };
const roles = { [A]: 'admin', [U]: 'user' };
const users = [
  { id: B, email: 'b@x.id', created_at: '2026-10-02T00:00:00Z', last_sign_in_at: null, banned_until: '2999-01-01T00:00:00Z' },
  { id: A, email: 'a@x.id', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: '2026-11-27T01:00:00Z', banned_until: null },
  { id: U, email: 'u@x.id', created_at: '2026-10-03T00:00:00Z', last_sign_in_at: null, banned_until: '2020-01-01T00:00:00Z' }
];
const profiles = [{ id: A, display_name: 'Paul', role: 'admin' }, { id: B, display_name: 'Budi', role: 'user' }];

const seenKeys = [];
let failAuth = false;
let profErr = false;
globalThis.__createClient = (url, key) => (seenKeys.push(key), {
  auth: {
    getUser: async (t) => failAuth ? (() => { throw new Error('jaringan putus'); })() : tokens[t]
      ? { data: { user: tokens[t] }, error: null }
      : { data: { user: null }, error: { message: 'invalid JWT' } },
    admin: {
      listUsers: async ({ page }) => ({ data: { users: page === 1 ? users : [] }, error: null }),
      createUser: async (a) => {
        log.createUser.push(a);
        if (a.email === 'a@x.id') return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
        return { data: { user: { id: NEW, email: a.email } }, error: null };
      },
      updateUserById: async (id, patch) => {
        log.updateUserById.push([id, patch]);
        return id === B || id === A ? { data: {}, error: null } : { data: null, error: { message: 'User not found' } };
      }
    }
  },
  from(table) {
    assert.strictEqual(table, 'profiles');
    let f = null;
    const q = {
      select() { return q; },
      eq(c, v) { f = [c, v]; return q; },
      maybeSingle: async () => profErr
        ? { data: null, error: { code: '42501', message: 'permission denied for table profiles' } }
        : ({ data: f && f[0] === 'id' && roles[f[1]] ? { role: roles[f[1]] } : null, error: null }),
      upsert: async (row, opts) => { log.upserts.push([row, opts]); return { error: null }; },
      then: (ok, ko) => Promise.resolve({ data: profiles, error: null }).then(ok, ko)
    };
    return q;
  }
});
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_baru","lain":"sb_secret_lain"}', SUPABASE_SERVICE_ROLE_KEY: 'service_lama' };
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve() {} };
const { handler } = await import(pathToFileURL(tmp).href);

const call = (body, token = 't-admin', raw) => handler(new Request('https://x/admin-users', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: raw !== undefined ? raw : JSON.stringify(body)
}));
const reset = () => { log.createUser.length = 0; log.updateUserById.length = 0; log.upserts.length = 0; };
const expectErr = async (res, status, re) => {
  const j = await res.json();
  assert.strictEqual(res.status, status, JSON.stringify(j));
  assert.match(j.error, re);
};

// --- CORS & metode
let res = await handler(new Request('https://x/admin-users', { method: 'OPTIONS' }));
assert.strictEqual(res.status, 204);
assert.ok(res.headers.get('access-control-allow-headers').includes('authorization'));
await expectErr(await handler(new Request('https://x/admin-users', { method: 'GET' })), 405, /POST/);

// --- otorisasi: tanpa token, token palsu/anon, bukan admin
await expectErr(await call({ action: 'list' }, null), 401, /belum masuk/);
await expectErr(await call({ action: 'list' }, 'kunci-anon-bukan-pengguna'), 401, /Sesi tidak valid/);
await expectErr(await call({ action: 'create', email: 'n@x.id', password: 'Rahasia123' }, 't-user'), 403, /Hanya admin/);
assert.strictEqual(log.createUser.length, 0, 'bukan admin: tidak ada akun yang dibuat');
await expectErr(await call(null, 't-admin', '{bukan json'), 400, /JSON/);
await expectErr(await call({ action: 'hapus-semua' }), 400, /Aksi tidak dikenal/);

// --- list
res = await call({ action: 'list' });
assert.strictEqual(res.status, 200);
let j = await res.json();
assert.deepStrictEqual(j.users.map((u) => u.id), [A, B, U], 'urut berdasarkan tanggal daftar');
assert.deepStrictEqual(j.users.map((u) => u.role), ['admin', 'user', 'user'], 'tanpa profil = user');
assert.deepStrictEqual(j.users.map((u) => u.display_name), ['Paul', 'Budi', '']);
assert.deepStrictEqual(j.users.map((u) => u.disabled), [false, true, false], 'blokir yang sudah lewat tidak dihitung');
assert.strictEqual(j.users[0].last_sign_in_at, '2026-11-27T01:00:00Z');

// --- create: validasi
await expectErr(await call({ action: 'create', email: 'bukan-email', password: 'Rahasia123' }), 400, /Email tidak valid/);
await expectErr(await call({ action: 'create', email: 'n@x.id', password: 'pendek' }), 400, /minimal 8/);
await expectErr(await call({ action: 'create', email: 'n@x.id', password: 'a'.repeat(73) }), 400, /maksimal 72/);
await expectErr(await call({ action: 'create', email: 'n@x.id', password: 'Rahasia123', display_name: 'x'.repeat(101) }), 400, /maksimal 100/);
assert.strictEqual(log.createUser.length, 0, 'validasi gagal: tidak memanggil Auth');

// --- create: berhasil
res = await call({ action: 'create', email: '  Baru@X.id ', password: 'Rahasia123', display_name: ' Baru ', role: 'admin' });
assert.strictEqual(res.status, 200);
assert.deepStrictEqual(await res.json(), { ok: true, user: { id: NEW, email: 'baru@x.id' } });
assert.deepStrictEqual(log.createUser[0], { email: 'baru@x.id', password: 'Rahasia123', email_confirm: true, user_metadata: { display_name: 'Baru' } });
assert.deepStrictEqual(log.upserts[0], [{ id: NEW, display_name: 'Baru', role: 'admin' }, { onConflict: 'id' }]);
reset();
await call({ action: 'create', email: 'tanpa.nama@x.id', password: 'Rahasia123', role: 'sembarang' });
assert.deepStrictEqual(log.upserts[0][0], { id: NEW, display_name: 'tanpa.nama', role: 'user' }, 'nama kosong = bagian lokal email; peran tak dikenal = user');
reset();
await expectErr(await call({ action: 'create', email: 'a@x.id', password: 'Rahasia123' }), 400, /Email sudah terdaftar/);
assert.strictEqual(log.upserts.length, 0, 'gagal membuat akun: tidak menulis profil');

// --- update: validasi dan pengaman akun sendiri
await expectErr(await call({ action: 'update', id: 'bukan-uuid', role: 'user' }), 400, /ID pengguna/);
await expectErr(await call({ action: 'update', id: B }), 400, /Tidak ada perubahan/);
await expectErr(await call({ action: 'update', id: A, role: 'user' }), 400, /mencabut peran admin dari akun sendiri/);
await expectErr(await call({ action: 'update', id: A, disabled: true }), 400, /menonaktifkan akun sendiri/);
await expectErr(await call({ action: 'update', id: B, role: 'superuser' }), 400, /Peran tidak valid/);
await expectErr(await call({ action: 'update', id: B, password: 'pendek' }), 400, /minimal 8/);
await expectErr(await call({ action: 'update', id: B, email: 'salah' }), 400, /Email tidak valid/);
assert.strictEqual(log.updateUserById.length, 0, 'validasi gagal: tidak ada perubahan');

// --- update: berhasil (hanya kolom yang dikirim)
res = await call({ action: 'update', id: B, email: 'Baru2@X.id', password: 'PasswordBaru1', display_name: 'Budi B', role: 'admin', disabled: true });
assert.deepStrictEqual(await res.json(), { ok: true });
assert.deepStrictEqual(log.updateUserById[0], [B, { email: 'baru2@x.id', email_confirm: true, password: 'PasswordBaru1', ban_duration: '876000h' }]);
assert.deepStrictEqual(log.upserts[0], [{ id: B, display_name: 'Budi B', role: 'admin' }, { onConflict: 'id' }]);
reset();
await call({ action: 'update', id: B, disabled: false });
assert.deepStrictEqual(log.updateUserById[0], [B, { ban_duration: 'none' }], 'aktifkan kembali = cabut blokir');
assert.strictEqual(log.upserts.length, 0, 'tanpa perubahan profil: tidak menulis profil');
reset();
await call({ action: 'update', id: B, display_name: 'Hanya Nama' });
assert.strictEqual(log.updateUserById.length, 0, 'hanya nama: Auth tidak disentuh');
assert.deepStrictEqual(log.upserts[0][0], { id: B, display_name: 'Hanya Nama' });
reset();
await call({ action: 'update', id: A, display_name: 'Paul W', role: 'admin' });      // mengubah diri sendiri yang aman
assert.deepStrictEqual(log.upserts[0][0], { id: A, display_name: 'Paul W', role: 'admin' });
await expectErr(await call({ action: 'update', id: NEW, role: 'user', password: 'Rahasia123' }), 400, /Pengguna tidak ditemukan/);

// --- pemilihan kunci rahasia (baru lebih diutamakan, lama sebagai cadangan)
seenKeys.length = 0;
await call({ action: 'list' });
assert.strictEqual(seenKeys[0], 'sb_secret_baru', 'kunci baru "default" dipakai lebih dulu');
ENV.SUPABASE_SECRET_KEYS = '{"hanya":"sb_secret_hanya"}';
seenKeys.length = 0; await call({ action: 'list' });
assert.strictEqual(seenKeys[0], 'sb_secret_hanya', 'tanpa "default": pakai kunci bernama pertama');
ENV.SUPABASE_SECRET_KEYS = 'bukan-json';
seenKeys.length = 0; await call({ action: 'list' });
assert.strictEqual(seenKeys[0], 'service_lama', 'JSON rusak: pakai kunci lama');
delete ENV.SUPABASE_SECRET_KEYS;
seenKeys.length = 0; await call({ action: 'list' });
assert.strictEqual(seenKeys[0], 'service_lama', 'tanpa kunci baru: pakai kunci lama');
delete ENV.SUPABASE_SERVICE_ROLE_KEY;
await expectErr(await call({ action: 'list' }), 500, /kunci rahasia tidak ditemukan/);
ENV.SUPABASE_SERVICE_ROLE_KEY = 'service_lama';

// --- kesalahan tak terduga menjadi JSON yang terbaca (bukan halaman galat platform)
failAuth = true;
const errSpy = console.error; console.error = () => {};
res = await call({ action: 'list' });
console.error = errSpy;
failAuth = false;
j = await res.json();
assert.strictEqual(res.status, 500);
assert.match(j.error, /Kesalahan server: jaringan putus/);

// --- galat izin saat membaca profil TIDAK boleh disamarkan sebagai "bukan admin" (kasus service_role tanpa GRANT)
profErr = true;
const errSpy2 = console.error; console.error = () => {};
res = await call({ action: 'list' });
console.error = errSpy2;
profErr = false;
j = await res.json();
assert.strictEqual(res.status, 500);
assert.match(j.error, /permission denied for table profiles/);
assert.match(j.error, /GRANT untuk service_role/);
assert.ok(!/Hanya admin/.test(j.error));

console.log('admin_users.test.mjs: semua tes lulus');
