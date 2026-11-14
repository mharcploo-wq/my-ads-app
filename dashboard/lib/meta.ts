import "server-only";
import { IngestPayload, prefixOf } from "./types";

const RESULT_ACTIONS = new Set([
  "purchase", "lead", "complete_registration",
  "offsite_conversion.fb_pixel_purchase", "offsite_conversion.fb_pixel_lead",
  "offsite_conversion.fb_pixel_complete_registration", "onsite_conversion.lead_grouped",
]);
export const DATE_PRESETS = ["today", "yesterday", "last_7d", "last_14d", "last_30d", "this_month", "last_month"];

export function metaConfig() {
  const token = (process.env.META_READ_TOKEN ?? "").trim();
  const account = (process.env.META_AD_ACCOUNT_ID ?? "").trim();
  const version = (process.env.GRAPH_API_VERSION ?? "v21.0").trim();
  const ready = token.length > 20 && /^act_\d+$/.test(account);
  return { token, account, version, ready, base: `https://graph.facebook.com/${version}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export function errMsg(body: Json): string {
  const e = body?.error;
  return e ? `${e.error_user_msg ?? e.message} (code ${e.code})` : JSON.stringify(body).slice(0, 200);
}

export async function get(url: string): Promise<{ ok: boolean; body: Json }> {
  try {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    const body = (await r.json()) as Json;
    return { ok: r.ok && !body.error, body };
  } catch (e) {
    return { ok: false, body: { error: { message: `เชื่อมต่อ Meta ไม่ได้: ${(e as Error).message}` } } };
  }
}

export async function getAll(url: string, maxPages = 20) {
  const first = await get(url);
  if (!first.ok) return { ok: false, rows: [] as Json[], error: errMsg(first.body) };
  const rows: Json[] = [...(first.body.data ?? [])];
  let next: string | undefined = first.body.paging?.next;
  for (let i = 1; next && i < maxPages; i++) {
    const page = await get(next);
    if (!page.ok) return { ok: false, rows, error: errMsg(page.body) };
    rows.push(...(page.body.data ?? []));
    next = page.body.paging?.next;
  }
  return { ok: true, rows, error: null as string | null };
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** ทดสอบการเชื่อมต่อแบบอ่านอย่างเดียว (โทเคน + บัญชีโฆษณา) */
export async function testMeta() {
  const c = metaConfig();
  const checks: { label: string; ok: boolean; detail: string }[] = [];
  if (!c.ready) {
    checks.push({ label: "ค่าใน .env.local", ok: false, detail: "ยังไม่ได้ตั้ง META_READ_TOKEN หรือ META_AD_ACCOUNT_ID (act_ตัวเลข)" });
    return { ok: false, checks };
  }
  checks.push({ label: "ค่าใน .env.local", ok: true, detail: `บัญชี ${c.account} · Graph ${c.version}` });
  const me = await get(`${c.base}/me?${q({ fields: "id,name", access_token: c.token })}`);
  checks.push({ label: "โทเคนใช้งานได้", ok: me.ok, detail: me.ok ? `โทเคนของ ${me.body.name ?? me.body.id}` : errMsg(me.body) });
  if (!me.ok) return { ok: false, checks };
  const acc = await get(`${c.base}/${c.account}?${q({ fields: "name,account_status,currency", access_token: c.token })}`);
  checks.push({
    label: "สิทธิ์อ่านบัญชีโฆษณา",
    ok: acc.ok,
    detail: acc.ok
      ? `${acc.body.name} · สกุลเงิน ${acc.body.currency} · สถานะ ${acc.body.account_status === 1 ? "ACTIVE" : acc.body.account_status}`
      : errMsg(acc.body),
  });
  return { ok: checks.every((x) => x.ok), checks };
}

/** ดึงแคมเปญ + ผลรายวันของทั้ง 3 prefix แล้วคืนเป็นรูป IngestPayload */
export async function pullFromMeta(datePreset: string): Promise<{ ok: boolean; error?: string; payload?: IngestPayload }> {
  const c = metaConfig();
  if (!c.ready) return { ok: false, error: "ยังไม่ได้ตั้ง META_READ_TOKEN / META_AD_ACCOUNT_ID ใน .env.local" };
  if (!DATE_PRESETS.includes(datePreset)) return { ok: false, error: "date_preset ไม่ถูกต้อง" };

  const camps = await getAll(`${c.base}/${c.account}/campaigns?${q({
    fields: "id,name,status,effective_status,objective,created_time", limit: "200", access_token: c.token,
  })}`);
  if (!camps.ok) return { ok: false, error: `อ่านแคมเปญไม่ได้: ${camps.error}` };

  const ins = await getAll(`${c.base}/${c.account}/insights?${q({
    level: "campaign", time_increment: "1", date_preset: datePreset, limit: "500", access_token: c.token,
    fields: "campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,actions",
  })}`);
  if (!ins.ok) return { ok: false, error: `อ่าน insights ไม่ได้: ${ins.error}` };

  return {
    ok: true,
    payload: {
      date_preset: datePreset,
      campaigns: camps.rows.filter((x) => prefixOf(x.name)).map((x) => ({
        id: x.id, name: x.name, status: x.effective_status ?? x.status, objective: x.objective, created_time: x.created_time,
      })),
      rows: ins.rows.filter((x) => prefixOf(x.campaign_name)).map((x) => ({
        date: x.date_start,
        campaign_id: x.campaign_id,
        campaign_name: x.campaign_name,
        spend: Number(x.spend ?? 0),
        impressions: Number(x.impressions ?? 0),
        reach: Number(x.reach ?? 0),
        clicks: Number(x.clicks ?? 0),
        link_clicks: Number(x.inline_link_clicks ?? 0),
        results: ((x.actions ?? []) as Json[])
          .filter((a) => RESULT_ACTIONS.has(a.action_type))
          .reduce((s, a) => s + Number(a.value ?? 0), 0),
      })),
    },
  };
}
