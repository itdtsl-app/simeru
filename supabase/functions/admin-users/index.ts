// Kelola pengguna dari halaman "Pengguna" (khusus admin): daftar, tambah, ubah.
//
// Membuat/mengubah akun memerlukan kunci service_role. Kunci itu HANYA ada di sini (server),
// tidak pernah dikirim ke browser. Setiap permintaan diperiksa ulang: pemanggil harus login
// DAN berperan admin di tabel profiles.
//
// Deploy (biarkan verifikasi JWT AKTIF, jangan pakai --no-verify-jwt):
//   supabase functions deploy admin-users
// Variabel SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY disediakan otomatis oleh Supabase.
//
// Permintaan: POST JSON  { "action": "list" | "create" | "update", ... }
//   list    -> { users: [{ id, email, display_name, role, created_at, last_sign_in_at, disabled }] }
//   create  -> { email, password, display_name?, role? }
//   update  -> { id, email?, password?, display_name?, role?, disabled? }   (hanya kolom yang dikirim yang diubah)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BAN_FOREVER = "876000h";   // sekitar 100 tahun; "none" mencabut blokir

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function validEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

// bcrypt (dipakai Supabase Auth) hanya membaca 72 byte pertama
function validPassword(v: string): string | null {
  if (v.length < 8) return "Password minimal 8 karakter";
  if (new TextEncoder().encode(v).length > 72) return "Password maksimal 72 byte";
  return null;
}

function explain(message: string): string {
  if (/already|registered|exists|duplicate/i.test(message)) return "Email sudah terdaftar";
  if (/not found/i.test(message)) return "Pengguna tidak ditemukan";
  return message;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Gunakan metode POST" });

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(500, { error: "Konfigurasi fungsi belum lengkap" });
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1) siapa yang memanggil?  (kunci anon juga lolos verifikasi gateway, jadi pemeriksaan ini wajib)
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "Anda belum masuk" });
  const who = await admin.auth.getUser(token);
  if (who.error || !who.data?.user) return json(401, { error: "Sesi tidak valid, silakan masuk lagi" });
  const callerId = who.data.user.id;

  // 2) apakah dia admin?
  const prof = await admin.from("profiles").select("role").eq("id", callerId).maybeSingle();
  if (prof.data?.role !== "admin") return json(403, { error: "Hanya admin yang boleh mengelola pengguna" });

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body harus berupa JSON" });
  }

  switch (body.action) {
    // ------------------------------------------------------------------ daftar
    case "list": {
      const users: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (r.error) return json(500, { error: r.error.message });
        users.push(...r.data.users);
        if (r.data.users.length < 1000) break;
      }
      const ps = await admin.from("profiles").select("id, display_name, role");
      if (ps.error) return json(500, { error: ps.error.message });
      const map = new Map<string, any>((ps.data ?? []).map((p: any) => [p.id, p]));
      users.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return json(200, {
        users: users.map((u) => ({
          id: u.id,
          email: u.email ?? "",
          display_name: map.get(u.id)?.display_name ?? "",
          role: map.get(u.id)?.role ?? "user",
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
          disabled: !!u.banned_until && Date.parse(u.banned_until) > Date.now(),
        })),
      });
    }

    // ------------------------------------------------------------------ tambah
    case "create": {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const name = String(body.display_name ?? "").trim();
      const role = body.role === "admin" ? "admin" : "user";
      if (!validEmail(email)) return json(400, { error: "Email tidak valid" });
      const pwErr = validPassword(password);
      if (pwErr) return json(400, { error: pwErr });
      if (name.length > 100) return json(400, { error: "Nama maksimal 100 karakter" });
      const display = name || email.split("@")[0];

      // email_confirm: true -> akun langsung aktif, tanpa email konfirmasi
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: display },
      });
      if (created.error || !created.data?.user) {
        return json(400, { error: explain(created.error?.message ?? "Gagal membuat akun") });
      }
      const id = created.data.user.id;
      // trigger database biasanya sudah membuat profil; upsert memastikan nama dan peran benar
      const up = await admin.from("profiles").upsert({ id, display_name: display, role }, { onConflict: "id" });
      if (up.error) {
        return json(500, { error: "Akun dibuat, tetapi profil gagal disimpan: " + up.error.message });
      }
      return json(200, { ok: true, user: { id, email } });
    }

    // ------------------------------------------------------------------ ubah
    case "update": {
      const id = String(body.id ?? "");
      if (!UUID_RE.test(id)) return json(400, { error: "ID pengguna tidak valid" });
      const authPatch: Record<string, unknown> = {};
      const profPatch: Record<string, unknown> = {};

      if (body.email !== undefined) {
        const email = String(body.email).trim().toLowerCase();
        if (!validEmail(email)) return json(400, { error: "Email tidak valid" });
        authPatch.email = email;
        authPatch.email_confirm = true;
      }
      if (body.password !== undefined && body.password !== "") {
        const pwErr = validPassword(String(body.password));
        if (pwErr) return json(400, { error: pwErr });
        authPatch.password = String(body.password);
      }
      if (body.display_name !== undefined) {
        const name = String(body.display_name).trim();
        if (name.length > 100) return json(400, { error: "Nama maksimal 100 karakter" });
        profPatch.display_name = name;
      }
      if (body.role !== undefined) {
        if (body.role !== "admin" && body.role !== "user") return json(400, { error: "Peran tidak valid" });
        if (id === callerId && body.role !== "admin") {
          return json(400, { error: "Anda tidak bisa mencabut peran admin dari akun sendiri" });
        }
        profPatch.role = body.role;
      }
      if (body.disabled !== undefined) {
        if (id === callerId && body.disabled) {
          return json(400, { error: "Anda tidak bisa menonaktifkan akun sendiri" });
        }
        authPatch.ban_duration = body.disabled ? BAN_FOREVER : "none";
      }
      if (!Object.keys(authPatch).length && !Object.keys(profPatch).length) {
        return json(400, { error: "Tidak ada perubahan" });
      }

      if (Object.keys(authPatch).length) {
        const r = await admin.auth.admin.updateUserById(id, authPatch);
        if (r.error) return json(400, { error: explain(r.error.message) });
      }
      if (Object.keys(profPatch).length) {
        const up = await admin.from("profiles").upsert({ id, ...profPatch }, { onConflict: "id" });
        if (up.error) return json(500, { error: "Profil gagal disimpan: " + up.error.message });
      }
      return json(200, { ok: true });
    }

    default:
      return json(400, { error: "Aksi tidak dikenal" });
  }
}

Deno.serve(handler);
