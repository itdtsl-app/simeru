// Feed acara per hari (RSS 2.0 atau JSON), pengganti rss.php di versi PHP.
//
//   .../functions/v1/feed                          RSS, hari ini, semua area
//   .../functions/v1/feed?format=json              JSON
//   .../functions/v1/feed?area=1&room=10           filter area / ruangan
//   .../functions/v1/feed?date=2026-11-27          tanggal tertentu (YYYY-MM-DD)
//
// Deploy (tanpa login JWT, karena feed bersifat publik seperti tampilan kalender):
//   supabase functions deploy feed --no-verify-jwt
// Variabel opsional (supabase secrets set ...):  SITE_URL, TZ_OFFSET, APP_TITLE
//
// Data dibaca dengan anon key, jadi tunduk pada RLS: bila policy "entries_read" dibatasi
// hanya untuk pengguna login, feed ini ikut kosong.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const TZ_OFFSET = Deno.env.get("TZ_OFFSET") ?? "+07:00";
const APP_TITLE = Deno.env.get("APP_TITLE") ?? "SIMERU DTSL";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/?$/, "/");

function pad(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

function offsetMinutes(off: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
  if (!m) throw new Error("TZ_OFFSET tidak valid: " + off);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function fmtDate(d: Date): string {
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

function parseDate(s: string | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return fmtDate(d) === s ? d : null;
}

function addDays(s: string, n: number): string {
  const d = parseDate(s)!;
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

function hhmm(ms: number): string {
  const t = new Date(ms + offsetMinutes(TZ_OFFSET) * 60000);
  return pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes());
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cdata(html: string): string {
  return "<![CDATA[" + html.replace(/\]\]>/g, "]]]]><![CDATA[>") + "]]>";
}

export async function handler(req: Request): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "rss";
  const areaId = parseInt(url.searchParams.get("area") ?? "", 10);
  const roomId = parseInt(url.searchParams.get("room") ?? "", 10);
  const today = fmtDate(new Date(Date.now() + offsetMinutes(TZ_OFFSET) * 60000));
  const dateParam = url.searchParams.get("date");
  const date = parseDate(dateParam) ? (dateParam as string) : today;

  const dayStart = date + "T00:00:00" + TZ_OFFSET;
  const dayEnd = addDays(date, 1) + "T00:00:00" + TZ_OFFSET;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  let q = sb.from("events")
    .select("id,name,description,type,color,tentative,start_time,end_time,room_id,room_name,area_id,area_name,created_by_name")
    .lt("start_time", dayEnd).gt("end_time", dayStart)
    .order("start_time").limit(1000);
  if (areaId > 0) q = q.eq("area_id", areaId);
  if (roomId > 0) q = q.eq("room_id", roomId);
  const { data, error } = await q;
  if (error) {
    return new Response("Database error: " + error.message, { status: 500, headers: cors });
  }

  const dayStartMs = Date.parse(dayStart), dayEndMs = Date.parse(dayEnd);
  const events = (data ?? []).map((e: Record<string, any>) => {
    const s = Date.parse(e.start_time), en = Date.parse(e.end_time);
    return {
      id: e.id,
      title: e.name,
      description: e.description ?? "",
      start: e.start_time,
      end: e.end_time,
      start_time: hhmm(Math.max(s, dayStartMs)),
      end_time: en >= dayEndMs ? "24:00" : hhmm(en),
      room: e.room_name, room_id: e.room_id,
      area: e.area_name, area_id: e.area_id,
      type: e.type, color: e.color, tentative: e.tentative,
      created_by: e.created_by_name ?? "",
      url: SITE_URL + "#view=list&date=" + date + "&area=" + e.area_id,
    };
  });

  const title = APP_TITLE + " - Jadwal Acara " + date;

  if (format === "json") {
    const body = JSON.stringify({ title, date, generated_at: new Date().toISOString(), count: events.length, events }, null, 2);
    return new Response(body, {
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "max-age=60" },
    });
  }

  const items = events.map((e: Record<string, any>) => {
    const html = "<p><b>" + esc(e.title) + "</b></p><p>Waktu: " + e.start_time + " - " + e.end_time +
      "<br>Ruang: " + esc(e.room) + " (" + esc(e.area) + ")" +
      (e.created_by ? "<br>Dibuat oleh: " + esc(e.created_by) : "") + "</p>" +
      (e.description ? "<p>" + esc(e.description).replace(/\n/g, "<br>") + "</p>" : "");
    return "    <item>\n" +
      "      <title>" + esc(e.start_time + "-" + e.end_time + "  " + e.title + "  @ " + e.room + (e.tentative ? " (Tentatif)" : "")) + "</title>\n" +
      "      <link>" + esc(e.url) + "</link>\n" +
      "      <guid isPermaLink=\"false\">" + esc("simeru-" + e.id + "-" + e.start) + "</guid>\n" +
      "      <pubDate>" + new Date(e.start).toUTCString() + "</pubDate>\n" +
      "      <category>" + esc(e.type === "E" ? "External" : "Internal") + "</category>\n" +
      "      <description>" + cdata(html) + "</description>\n" +
      "    </item>\n";
  }).join("");

  const xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<rss version=\"2.0\">\n  <channel>\n" +
    "    <title>" + esc(title) + "</title>\n" +
    "    <link>" + esc(SITE_URL + "#view=list&date=" + date) + "</link>\n" +
    "    <description>" + esc("Daftar acara/peminjaman ruang " + date + " (" + events.length + " acara)") + "</description>\n" +
    "    <language>id</language>\n" +
    "    <lastBuildDate>" + new Date().toUTCString() + "</lastBuildDate>\n" +
    "    <ttl>5</ttl>\n" + items + "  </channel>\n</rss>\n";

  return new Response(xml, {
    headers: { ...cors, "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "max-age=60" },
  });
}

Deno.serve(handler);
