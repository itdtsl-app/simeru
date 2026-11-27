-- =====================================================================
-- OPSIONAL: hanya untuk menu "Daftar pengguna" (khusus admin).
-- Jalankan sekali di SQL Editor Supabase. Tanpa ini, menu lain tetap berfungsi.
-- =====================================================================

-- Daftar akun (email ada di auth.users, jadi perlu fungsi SECURITY DEFINER yang hanya mau melayani admin)
create or replace function public.list_users()
returns table (id uuid, email text, display_name text, role text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then
    raise exception 'Hanya admin yang boleh melihat daftar pengguna' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, p.display_name, p.role, u.created_at, u.last_sign_in_at
      from auth.users u
      left join public.profiles p on p.id = u.id
     order by u.created_at;
end $$;

-- Ubah peran (admin / user)
create or replace function public.set_user_role(p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Hanya admin yang boleh mengubah peran' using errcode = '42501';
  end if;
  if p_role not in ('user', 'admin') then
    raise exception 'Peran tidak valid';
  end if;
  if p_user = auth.uid() and p_role <> 'admin' then
    raise exception 'Anda tidak bisa mencabut peran admin dari akun sendiri';
  end if;
  update public.profiles set role = p_role where id = p_user;
  if not found then
    raise exception 'Pengguna tidak ditemukan';
  end if;
end $$;

-- Hanya pengguna login yang boleh memanggil (pemeriksaan admin dilakukan di dalam fungsi)
revoke all on function public.list_users() from public, anon;
revoke all on function public.set_user_role(uuid, text) from public, anon;
grant execute on function public.list_users() to authenticated;
grant execute on function public.set_user_role(uuid, text) to authenticated;
