import "server-only";
import { errMsg, get, getAll, Json, metaConfig } from "./meta";
import { prefixOf } from "./types";
import {
  AgeCell, DailyPoint, InsightsData, Level, Metrics, Node, PlacementRow, RangeKey, RANGES, Rank, Rec, Result,
  ResultTotal, Sev, WhoKey, WHOS,
} from "./insightsTypes";

/** หน้า "วิเคราะห์โฆษณา" — อ่านอย่างเดียวจาก Marketing API (ads_read) ด้วย META_READ_TOKEN
 *  ไม่แก้อะไรบน Meta · ผลเก็บไว้ 10 นาทีกันเรียกถี่เกินโควตา · คำแนะนำคิดที่นี่ (หน้าเว็บแค่แสดง) */

const TTL_MS = 10 * 60_000;
const MIN_REFRESH_MS = 2 * 60_000;   // ปุ่ม ↻ ดึงใหม่ได้เมื่อชุดเดิมเก่ากว่า 2 นาที (โควตา Meta นับรวมทั้งบัญชี — กันแย่งกับการสร้างโฆษณา)
// เก็บไว้บน globalThis — dev server รีโหลดโค้ดแล้วผลเดิมไม่หาย (ไม่ต้องยิง Meta ซ้ำ)
const g = globalThis as unknown as { __adsInsightsCache?: Map<string, { at: number; data: InsightsData }> };
const cache = (g.__adsInsightsCache ??= new Map());

/** Meta จำกัดจำนวนคำขอ (code 4 / 17 / 613 / 80000–80014) → บอกเป็นภาษาคน */
function friendly(msg: string): string {
  const m = msg.match(/\(code (\d+)\)/);
  const code = m ? Number(m[1]) : 0;
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014))
    return `Meta จำกัดการเรียกข้อมูลของบัญชีนี้ชั่วคราว (เรียกถี่เกินไป · ${msg.split(" ไม่ได้")[0]}) — รอประมาณ 5–10 นาทีแล้วกด ↻ ดึงใหม่ · ระหว่างนี้การสร้างโฆษณาอาจติดข้อจำกัดเดียวกัน`;
  return msg;
}

// ---------- เกณฑ์คำแนะนำ (ผู้ใช้เคาะ 14/11: 2A) ----------
export const RULE = {
  costRatio: 1.5,        // ต้นทุนต่อผลลัพธ์ > 1.5 เท่าของเฉลี่ยชนิดเดียวกัน
  zeroSpend: 300,        // ใช้ ≥ ฿300 แล้วผลลัพธ์ 0
  frequency: 3,          // ความถี่เกิน 3
  ctr: 1,                // CTR ลิงก์ต่ำกว่า 1% …
  ctrImpressions: 1000,  // … เมื่อมีการแสดงผล ≥ 1,000
  placementShare: 0.1,   // ตำแหน่งที่ใช้งบ ≥ 10% …
  placementCpc: 2,       // … และต้นทุนต่อคลิกเกิน 2 เท่าของบัญชี
  oldShare: 0.3,         // อายุ 55+ ใช้งบ ≥ 30%
  spendGrowth: 0.5,      // ใช้เงินเพิ่ม ≥ 50% จากช่วงก่อน
};
const RULES_TEXT = [
  { key: "cost", text: `ต้นทุนต่อผลลัพธ์เกิน ${RULE.costRatio} เท่าของค่าเฉลี่ยผลลัพธ์ชนิดเดียวกัน (ต้องมี ≥ 2 แคมเปญชนิดนั้น)` },
  { key: "zero", text: `ชุดโฆษณาใช้ไป ≥ ฿${RULE.zeroSpend} แต่ผลลัพธ์ 0` },
  { key: "freq", text: `ความถี่ของชุดโฆษณาเกิน ${RULE.frequency}` },
  { key: "ctr", text: `CTR ลิงก์ของโฆษณาต่ำกว่า ${RULE.ctr}% (เมื่อแสดงผล ≥ ${RULE.ctrImpressions.toLocaleString("en-US")} ครั้ง)` },
  { key: "rank", text: "อันดับคุณภาพหรือ conversion ของโฆษณาต่ำกว่าค่าเฉลี่ย (Meta จัดให้)" },
  { key: "placement", text: `ตำแหน่งโฆษณาที่ใช้งบ ≥ ${RULE.placementShare * 100}% และต้นทุนต่อคลิกเกิน ${RULE.placementCpc} เท่าของค่าเฉลี่ยบัญชี` },
  { key: "age", text: `ผู้ชมอายุ 55+ ใช้งบ ≥ ${RULE.oldShare * 100}%` },
  { key: "growth", text: `ใช้เงินเพิ่ม ≥ ${RULE.spendGrowth * 100}% จากช่วงก่อนหน้าที่ยาวเท่ากัน` },
  { key: "paused", text: "ของที่ปิดไปแล้ว ลดป้ายเป็น \"ควรดู\" และติดป้าย \"ปิดอยู่แล้ว\" — ป้ายแดง/ส้มเหลือไว้เฉพาะของที่ยังเปิด" },
];

// ---------- ชนิดผลลัพธ์ ----------
const RESULT_NAMES: Record<string, [string, string, string]> = {
  omni_landing_page_view: ["การเข้าชมแลนดิ้งเพจ", "ครั้ง", "เข้าชมหน้า"],
  landing_page_view: ["การเข้าชมแลนดิ้งเพจ", "ครั้ง", "เข้าชมหน้า"],
  "onsite_conversion.lead_grouped": ["ลีดจาก Meta (ฟอร์ม/ข้อความ)", "ลีด", "ลีด"],
  lead: ["ลีด", "ลีด", "ลีด"],
  "offsite_conversion.fb_pixel_lead": ["ลีดบนเว็บไซต์", "ลีด", "ลีด"],
  "onsite_conversion.messaging_conversation_started_7d": ["การเริ่มสนทนา", "ครั้ง", "แชต"],
  "onsite_conversion.total_messaging_connection": ["การติดต่อทางข้อความ", "ครั้ง", "แชต"],
  link_click: ["คลิกลิงก์", "คลิก", "คลิก"],
  post_engagement: ["การมีส่วนร่วมกับโพสต์", "ครั้ง", "มีส่วนร่วม"],
  page_engagement: ["การมีส่วนร่วมกับเพจ", "ครั้ง", "มีส่วนร่วม"],
  like: ["การถูกใจเพจ", "ครั้ง", "ถูกใจ"],
  video_view: ["การดูวิดีโอ", "ครั้ง", "ดูวิดีโอ"],
  omni_purchase: ["การซื้อ", "ครั้ง", "ซื้อ"],
  "offsite_conversion.fb_pixel_purchase": ["การซื้อบนเว็บไซต์", "ครั้ง", "ซื้อ"],
  omni_complete_registration: ["การลงทะเบียน", "ครั้ง", "ลงทะเบียน"],
};
const PER_THOUSAND = new Set(["reach", "impressions"]);

function resultName(indicator: string): [string, string, string, number] {
  const k = indicator.replace(/^actions:/, "");
  if (k === "reach") return ["การเข้าถึง", "คน", "เข้าถึง", 1000];
  if (k === "impressions") return ["การแสดงผล", "ครั้ง", "แสดงผล", 1000];
  if (k.startsWith("video_thruplay")) return ["ThruPlay", "ครั้ง", "ThruPlay", 1];
  const n = RESULT_NAMES[k];
  return n ? [...n, 1] : [k, "ครั้ง", k.slice(0, 12), 1];
}

/** ฟิลด์ results ของ Meta → ผลลัพธ์ 1 ชนิด · ไม่มีฟิลด์ = null · มีแต่ไม่มีค่า = 0 */
function resultOf(r: Json, spend: number): Result | null {
  const x = (r.results as Json[] | undefined)?.[0];
  if (!x?.indicator) return null;
  const value = Number(x.values?.[0]?.value ?? 0);
  const [label, unit, short, per] = resultName(String(x.indicator));
  return { indicator: String(x.indicator), label, unit, short, value, per, cost: value ? (spend / value) * per : null };
}

const num = (v: unknown) => Number(v ?? 0) || 0;
function metricsOf(r: Json): Metrics {
  const spend = num(r.spend), imp = num(r.impressions), lc = num(r.inline_link_clicks);
  return {
    spend, impressions: imp, reach: num(r.reach), frequency: num(r.frequency), link_clicks: lc,
    link_ctr: imp ? (lc / imp) * 100 : 0, link_cpc: lc ? spend / lc : null, cpm: imp ? (spend / imp) * 1000 : null,
  };
}
const EMPTY: Metrics = { spend: 0, impressions: 0, reach: 0, frequency: 0, link_clicks: 0, link_ctr: 0, link_cpc: null, cpm: null };

function rank(v: unknown): Rank {
  const s = String(v ?? "");
  if (!s || s === "UNKNOWN") return { level: null, text: "ยังไม่มี (ต้องมีการแสดงผลมากพอ)" };
  if (s.startsWith("ABOVE")) return { level: "above", text: "สูงกว่าค่าเฉลี่ย" };
  const m = s.match(/^BELOW_AVERAGE_(\d+)/);
  if (m) return { level: "below", text: `ต่ำกว่าค่าเฉลี่ย (กลุ่มล่าง ${m[1]}%)` };
  if (s.startsWith("BELOW")) return { level: "below", text: "ต่ำกว่าค่าเฉลี่ย" };
  return { level: "average", text: "เท่าค่าเฉลี่ย" };
}

// ---------- ป้าย/ลิงก์ ----------
const PLACEMENT: Record<string, string> = {
  facebook_reels: "Facebook Reels", facebook_reels_overlay: "Facebook Reels (แถบซ้อน)", facebook_stories: "Facebook Stories",
  instagram_reels: "Instagram Reels", instagram_stories: "Instagram Stories", instagram_explore: "Instagram Explore",
  instagram_explore_grid_home: "Instagram Explore (หน้าแรก)", search: "ผลการค้นหา", facebook_notification: "การแจ้งเตือน",
  facebook_profile_feed: "ฟีดโปรไฟล์", instream_video: "วิดีโอในสตรีม", marketplace: "Marketplace", right_hand_column: "คอลัมน์ขวา",
  video_feeds: "ฟีดวิดีโอ", an_classic: "Audience Network", rewarded_video: "วิดีโอรับรางวัล", messenger_inbox: "กล่องข้อความ Messenger",
  messenger_stories: "Messenger Stories", threads_feed: "ฟีด Threads",
};
const PLATFORM: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger", threads: "Threads" };
function placementLabel(platform: string, pos: string) {
  if (pos === "feed") return `${PLATFORM[platform] ?? platform} ฟีด`;
  return PLACEMENT[pos] ?? `${PLATFORM[platform] ?? platform} · ${pos}`;
}

function amLink(act: string, level: Level, id: string) {
  const n = act.replace(/^act_/, "");
  const page = { campaign: "campaigns", adset: "adsets", ad: "ads" }[level];
  return `https://adsmanager.facebook.com/adsmanager/manage/${page}?act=${n}&selected_${level}_ids=${id}`;
}

const baht = (v: number, d = 2) => `฿${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const int = (v: number) => Math.round(v).toLocaleString("en-US");
const short = (s: string, k = 48) => (s.length > k ? s.slice(0, k - 1) + "…" : s);

function shiftDay(d: string, by: number) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + by);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000) + 1;
}

export function isRange(v: string): v is RangeKey { return RANGES.some((r) => r.key === v); }
export function isWho(v: string): v is WhoKey { return (WHOS as readonly string[]).includes(v); }

// ---------- ดึงข้อมูล ----------
const FIELDS = "spend,impressions,reach,frequency,inline_link_clicks,results";
const NODE_FIELDS = {
  campaign: `campaign_id,campaign_name,objective,${FIELDS}`,
  adset: `campaign_id,adset_id,adset_name,${FIELDS}`,
  ad: `campaign_id,adset_id,ad_id,ad_name,${FIELDS},quality_ranking,engagement_rate_ranking,conversion_rate_ranking`,
};

export async function getInsights(range: RangeKey, who: WhoKey, fresh: boolean): Promise<InsightsData | { ok: false; error: string }> {
  const key = `${range}|${who}`;
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < TTL_MS && !(fresh && age > MIN_REFRESH_MS)) return hit.data;
  try {
    const data = await pull(range, who);
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    const why = friendly((e as Error).message);
    // ดึงใหม่ไม่ได้ (เช่น เรียกถี่เกินโควตา) → ยังแสดงชุดเดิมได้ พร้อมบอกเหตุผล
    if (hit) return { ...hit.data, stale: why };
    return { ok: false, error: why };
  }
}

async function pull(range: RangeKey, who: WhoKey): Promise<InsightsData> {
  const c = metaConfig();
  if (!c.ready) throw new Error("ยังไม่ได้ตั้ง META_READ_TOKEN / META_AD_ACCOUNT_ID ใน dashboard/.env.local (ตั้งได้ที่แท็บ เชื่อมต่อ API)");
  const q = (o: Record<string, string>) => new URLSearchParams({ ...o, access_token: c.token }).toString();
  const must = async (url: string, what: string) => {
    const r = await getAll(url, 30);
    if (!r.ok) throw new Error(`อ่าน${what}จาก Meta ไม่ได้: ${r.error}`);
    return r.rows;
  };

  // 1) บัญชี + รายการแคมเปญ (ชื่อ/สถานะ) ในคำขอเดียว — ใช้ทั้งตัวกรอง agent และป้าย "ปิดอยู่แล้ว"
  //    คำขอแบบนี้กินโควตา ads_management ก้อนเดียวกับการสร้างโฆษณา → ใช้ให้น้อยที่สุด (insights ใช้โควตาแยก)
  const accRes = await get(`${c.base}/${c.account}?${q({ fields: "name,currency,campaigns.limit(500){id,name,effective_status}" })}`);
  if (!accRes.ok) throw new Error(`อ่านบัญชีโฆษณาจาก Meta ไม่ได้: ${errMsg(accRes.body)}`);
  const campList = ((accRes.body.campaigns?.data ?? []) as Json[]);
  const status = new Map<string, string>();
  campList.forEach((x) => status.set(String(x.id), String(x.effective_status ?? "")));
  const isActive = (id: string) => status.get(id) === "ACTIVE";

  const pick = (name: string) => {
    const p = prefixOf(name);
    if (who === "all") return true;
    if (who === "agent") return !!p;
    if (who === "human") return !p;
    return p === who;
  };
  const chosen = campList.filter((x) => pick(String(x.name)));
  const base = {
    ok: true as const,
    account: { id: c.account, name: String(accRes.body.name ?? c.account), currency: String(accRes.body.currency ?? "") },
    range, who, fetched_at: new Date().toISOString(), stale: null,
    counts: { campaigns: chosen.length, active: chosen.filter((x) => x.effective_status === "ACTIVE").length },
    rules: RULES_TEXT,
  };
  const emptyResult = (): InsightsData => ({
    ...base, period: null, prevPeriod: null, total: EMPTY, prev: null, results: [], daily: [], campaigns: [],
    idle: chosen.map((x) => ({ id: String(x.id), name: String(x.name), agent: prefixOf(String(x.name)) })),
    age: [], placements: [], recs: base.counts.active ? [] : [noLiveRec(base.counts.campaigns)],
  });
  if (who !== "all" && !chosen.length) return emptyResult();
  const filtering: Record<string, string> = who === "all" ? {} : { filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: chosen.map((x) => String(x.id)) }]) };
  const ins = (o: Record<string, string>) => `${c.base}/${c.account}/insights?${q({ limit: "500", ...filtering, ...o })}`;

  // 2) ยอดรวมของช่วงนี้ — ได้วันเริ่ม/จบจริงของช่วง (ตามเขตเวลาบัญชี) ไว้คิดช่วงก่อนหน้า
  const totalRows = await must(ins({ date_preset: range, fields: "spend,impressions,reach,frequency,inline_link_clicks" }), "ยอดรวม");
  if (!totalRows.length) return emptyResult();
  const T = totalRows[0];
  const since = String(T.date_start), until = String(T.date_stop), days = daysBetween(since, until);
  const prevPeriod = { since: shiftDay(since, -days), until: shiftDay(since, -1) };

  // 3) ที่เหลือดึงพร้อมกัน
  const [prevRows, campRows, adsetRows, adRows, dailyRows, ageRows, plcRows] = await Promise.all([
    must(ins({ time_range: JSON.stringify(prevPeriod), fields: "spend,impressions,reach,frequency,inline_link_clicks" }), "ยอดช่วงก่อนหน้า"),
    must(ins({ date_preset: range, level: "campaign", fields: NODE_FIELDS.campaign }), "ผลรายแคมเปญ"),
    must(ins({ date_preset: range, level: "adset", fields: NODE_FIELDS.adset }), "ผลรายชุดโฆษณา"),
    must(ins({ date_preset: range, level: "ad", fields: NODE_FIELDS.ad }), "ผลรายโฆษณา"),
    must(ins({ date_preset: range, time_increment: "1", fields: "spend,impressions,inline_link_clicks,results" }), "ผลรายวัน"),
    must(ins({ date_preset: range, breakdowns: "age,gender", fields: "spend,inline_link_clicks" }), "ผลแยกอายุ/เพศ"),
    must(ins({ date_preset: range, breakdowns: "publisher_platform,platform_position", fields: "spend,inline_link_clicks" }), "ผลแยกตำแหน่งโฆษณา"),
  ]);
  const total = metricsOf(T);
  const prev = prevRows.length ? metricsOf(prevRows[0]) : null;

  // สถานะของชุด/โฆษณา — แคมเปญที่ปิดอยู่ ชุด/โฆษณาข้างในไม่วิ่งแน่นอน (ใช้สถานะแคมเปญแทน ไม่ต้องถาม Meta)
  //    ถามเฉพาะเมื่อมีแคมเปญที่ใช้เงินในช่วงนี้และยังเปิดอยู่ (2 คำขอ · กรองเฉพาะแคมเปญเหล่านั้น)
  const spentIds = [...new Set(campRows.map((r) => String(r.campaign_id)))].filter(isActive);
  if (spentIds.length) {
    const only = { fields: "id,effective_status", limit: "500", filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: spentIds }]) };
    const [adsetSt, adSt] = await Promise.all([
      must(`${c.base}/${c.account}/adsets?${q(only)}`, "สถานะชุดโฆษณา"),
      must(`${c.base}/${c.account}/ads?${q(only)}`, "สถานะโฆษณา"),
    ]);
    [...adsetSt, ...adSt].forEach((x) => status.set(String(x.id), String(x.effective_status ?? "")));
  }

  // ---------- ต้นไม้ แคมเปญ → ชุด → โฆษณา ----------
  const act = c.account;
  // ชุด/โฆษณาในแคมเปญที่ปิด: ไม่ได้ถามสถานะ → ใช้สถานะแคมเปญแม่ และนับว่าปิด
  const node = (r: Json, level: Level, id: string, name: string): Node => {
    const m = metricsOf(r);
    return {
      id, name, level, status: status.get(id) ?? status.get(String(r.campaign_id)) ?? "", active: isActive(id), agent: prefixOf(name), m, result: resultOf(r, m.spend),
      ...(level === "ad" ? { ranking: { quality: rank(r.quality_ranking), engagement: rank(r.engagement_rate_ranking), conversion: rank(r.conversion_rate_ranking) } } : {}),
      flag: null, link: amLink(act, level, id), children: [],
    };
  };
  const ads = adRows.map((r) => ({ parent: String(r.adset_id), n: node(r, "ad", String(r.ad_id), String(r.ad_name)) }));
  const adsets = adsetRows.map((r) => {
    const n = node(r, "adset", String(r.adset_id), String(r.adset_name));
    n.children = ads.filter((a) => a.parent === n.id).map((a) => a.n).sort((a, b) => b.m.spend - a.m.spend);
    return { parent: String(r.campaign_id), n };
  });
  const campaigns = campRows.map((r) => {
    const n = node(r, "campaign", String(r.campaign_id), String(r.campaign_name));
    n.children = adsets.filter((a) => a.parent === n.id).map((a) => a.n).sort((a, b) => b.m.spend - a.m.spend);
    return n;
  }).sort((a, b) => b.m.spend - a.m.spend);
  const spent = new Set(campaigns.map((x) => x.id));
  const idle = chosen.filter((x) => !spent.has(String(x.id))).map((x) => ({ id: String(x.id), name: String(x.name), agent: prefixOf(String(x.name)) }));

  // ---------- ผลลัพธ์แยกชนิด (ไม่บวกข้ามชนิด) ----------
  const byInd = new Map<string, ResultTotal>();
  campaigns.forEach((x) => {
    if (!x.result) return;
    const b = byInd.get(x.result.indicator) ?? { indicator: x.result.indicator, label: x.result.label, unit: x.result.unit, value: 0, spend: 0, cost: null, per: x.result.per, campaigns: 0 };
    b.value += x.result.value; b.spend += x.m.spend; b.campaigns++;
    byInd.set(x.result.indicator, b);
  });
  const results = [...byInd.values()].map((b) => ({ ...b, cost: b.value ? (b.spend / b.value) * b.per : null })).sort((a, b) => b.spend - a.spend);

  // ---------- รายวัน (วันที่ไม่มีการแสดงผล = 0) ----------
  const dmap = new Map(dailyRows.map((r) => [String(r.date_start), r]));
  const daily: DailyPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = shiftDay(since, i), r = dmap.get(d);
    daily.push({
      date: d, spend: num(r?.spend), impressions: num(r?.impressions), link_clicks: num(r?.inline_link_clicks),
      // นับจำนวนผลลัพธ์รวมทุกชนิด ยกเว้นการเข้าถึง/การแสดงผล (หน่วยคนละแบบ)
      results: ((r?.results as Json[]) ?? []).filter((x) => !PER_THOUSAND.has(String(x.indicator).replace(/^actions:/, "")))
        .reduce((s, x) => s + num(x.values?.[0]?.value), 0),
    });
  }

  const age: AgeCell[] = ageRows.filter((r) => r.age !== "Unknown").map((r) => ({
    age: String(r.age), gender: (["female", "male"].includes(r.gender) ? r.gender : "unknown") as AgeCell["gender"],
    spend: num(r.spend), link_clicks: num(r.inline_link_clicks),
  }));

  const accCpc = total.link_clicks ? total.spend / total.link_clicks : null;
  const placements: PlacementRow[] = plcRows.map((r) => {
    const spend = num(r.spend), lc = num(r.inline_link_clicks);
    const share = total.spend ? spend / total.spend : 0, cpc = lc ? spend / lc : null;
    return {
      key: `${r.publisher_platform}:${r.platform_position}`, label: placementLabel(String(r.publisher_platform), String(r.platform_position)),
      spend, link_clicks: lc, share, cpc,
      hot: share >= RULE.placementShare && accCpc !== null && (cpc === null || cpc >= accCpc * RULE.placementCpc),
    };
  }).filter((p) => p.spend >= 1).sort((a, b) => b.spend - a.spend);

  const recs = buildRecs({ campaigns, results, total, prev, age, placements, accCpc, counts: base.counts });
  return { ...base, period: { since, until, days }, prevPeriod, total, prev, results, daily, campaigns, idle, age, placements, recs };
}

// ---------- กฎคำแนะนำ ----------
const ORDER: Record<Sev, number> = { critical: 0, serious: 1, warning: 2, info: 3 };

function noLiveRec(n: number): Rec {
  return { id: "no-live", sev: "info", title: "ตอนนี้ไม่มีแคมเปญที่เปิดอยู่", evidence: `${n} แคมเปญตรงตัวกรอง · เปิดอยู่ 0`,
    suggest: "ตัวเลขในหน้านี้เป็นผลย้อนหลังของแคมเปญที่ปิดไปแล้ว", paused: false, link: null };
}

function buildRecs(x: {
  campaigns: Node[]; results: ResultTotal[]; total: Metrics; prev: Metrics | null; age: AgeCell[];
  placements: PlacementRow[]; accCpc: number | null; counts: { campaigns: number; active: number };
}): Rec[] {
  const recs: Rec[] = [];
  const flag = (n: Node, s: Sev) => { if (!n.flag || ORDER[s] < ORDER[n.flag]) n.flag = s; };
  /** ของที่ปิดอยู่แล้ว: ป้ายแดง/ส้ม → "ควรดู" (3A) */
  const add = (r: Omit<Rec, "paused">, live: boolean, ...targets: Node[]) => {
    const sev: Sev = !live && (r.sev === "critical" || r.sev === "serious") ? "warning" : r.sev;
    targets.forEach((t) => flag(t, sev));
    recs.push({ ...r, sev, paused: !live });
  };
  const adsets = x.campaigns.flatMap((c) => c.children.map((a) => ({ c, a })));
  const ads = adsets.flatMap(({ c, a }) => a.children.map((ad) => ({ c, a, ad })));
  const byInd = new Map(x.results.map((r) => [r.indicator, r]));

  // R1 ต้นทุนต่อผลลัพธ์แพงกว่าเฉลี่ยชนิดเดียวกัน
  x.campaigns.forEach((c) => {
    const r = c.result, b = r && byInd.get(r.indicator);
    if (!r?.value || !b || b.campaigns < 2 || !b.cost || !r.cost) return;
    if (r.cost > b.cost * RULE.costRatio) {
      add({ id: `cost-${c.id}`, sev: "serious", title: `ต้นทุนต่อ${r.label}แพงกว่าเฉลี่ย ${(r.cost / b.cost).toFixed(1)} เท่า`,
        evidence: `${short(c.name)} · ${baht(r.cost)} ต่อ${r.unit} (เฉลี่ยชนิดเดียวกัน ${baht(b.cost)}) · ใช้ไป ${baht(c.m.spend)} ได้ ${int(r.value)} ${r.unit}`,
        suggest: "ลองย้ายงบไปแคมเปญชนิดเดียวกันที่ต้นทุนต่ำกว่า หรือเปลี่ยนชิ้นงาน/ข้อความแรกที่ลูกค้าเห็น แล้วเทียบผล 7 วัน", link: c.link }, c.active, c);
    }
  });
  /** กฎที่ชี้ทีละชุด/ทีละโฆษณา → รวมเป็นการ์ดเดียวต่อกฎ (แยกของที่ยังเปิด/ปิดแล้ว) · ยกตัวอย่าง 3 อันที่หนักสุด
   *  ไอคอนในตารางยังติดครบทุกแถว */
  type Hit = { n: Node; also: Node[]; line: string };
  const group = (key: string, sev: Sev, hits: Hit[], title: (k: number) => string, suggest: (live: boolean) => string) => {
    for (const live of [true, false]) {
      const hs = hits.filter((h) => h.n.active === live);
      if (!hs.length) continue;
      const more = hs.length > 3 ? ` · และอีก ${hs.length - 3} รายการ (ดู ⚠ ในตาราง)` : "";
      add({ id: `${key}-${live ? "live" : "off"}`, sev, title: title(hs.length), evidence: hs.slice(0, 3).map((h) => h.line).join(" · ") + more,
        suggest: suggest(live), link: hs[0].n.link }, live, ...hs.flatMap((h) => [h.n, ...h.also]));
    }
  };
  // R2 ใช้เงินแล้วผลลัพธ์ 0 (เรียงจากใช้เงินมากสุด)
  const zero = adsets.filter(({ a }) => a.result && a.result.value === 0 && a.m.spend >= RULE.zeroSpend).sort((p, q) => q.a.m.spend - p.a.m.spend);
  group("zero", "critical", zero.map(({ c, a }) => ({ n: a, also: [c], line: `${short(a.name, 40)} ใช้ไป ${baht(a.m.spend)} · ${a.result!.label} 0` })),
    (k) => `ชุดโฆษณา ${k} ชุดใช้เงินแล้วแต่ยังไม่มีผลลัพธ์`,
    (live) => live ? "เช็คว่าเป้าหมายการปรับให้เหมาะสมตรงกับที่ต้องการ และลิงก์/ฟอร์มปลายทางใช้ได้ — ถ้ายังไม่มีผลลัพธ์ พิจารณาหยุดชุดนั้นใน Ads Manager"
      : "ปิดไปแล้ว — ก่อนเปิดรอบหน้า เทียบชิ้นงาน/ข้อความของชุดเหล่านี้กับชุดที่ได้ผลลัพธ์ในแคมเปญเดียวกัน");
  // R3 ความถี่สูง
  const freq = adsets.filter(({ a }) => a.m.frequency > RULE.frequency).sort((p, q) => q.a.m.frequency - p.a.m.frequency);
  group("freq", "warning", freq.map(({ c, a }) => ({ n: a, also: [c], line: `${short(a.name, 40)} ความถี่ ${a.m.frequency.toFixed(1)}` })),
    (k) => `ชุดโฆษณา ${k} ชุดความถี่สูง — คนเดิมเห็นซ้ำเกิน ${RULE.frequency} ครั้ง`,
    () => "คนเริ่มเบื่อโฆษณาเดิม — เพิ่มชิ้นงานใหม่หรือขยายกลุ่มเป้าหมาย");
  // R4 CTR ลิงก์ต่ำ (เรียงจากแสดงผลมากสุด)
  const ctr = ads.filter(({ ad }) => ad.m.impressions >= RULE.ctrImpressions && ad.m.link_ctr < RULE.ctr).sort((p, q) => q.ad.m.impressions - p.ad.m.impressions);
  group("ctr", "warning", ctr.map(({ ad }) => ({ n: ad, also: [], line: `${short(ad.name, 40)} CTR ${ad.m.link_ctr.toFixed(2)}% (แสดงผล ${int(ad.m.impressions)})` })),
    (k) => `โฆษณา ${k} ชิ้น CTR ลิงก์ต่ำกว่า ${RULE.ctr}%`,
    () => "ลองพาดหัวหรือภาพแรกใหม่ ให้บอกประโยชน์ชัดในวินาทีแรก — ถ้าเป้าหมายแคมเปญไม่ใช่คลิก (เช่น ข้อความ/การมีส่วนร่วม) ข้อนี้สำคัญน้อยกว่า");
  // R8 อันดับ Meta ต่ำ (รวมเป็นการ์ดเดียว)
  const low = ads.filter(({ ad }) => ad.ranking && (ad.ranking.quality.level === "below" || ad.ranking.conversion.level === "below"));
  if (low.length) {
    const live = low.some(({ ad }) => ad.active);
    const engaged = low.filter(({ ad }) => ad.ranking?.engagement.level === "above").length;
    add({ id: "rank", sev: "warning", title: `โฆษณา ${low.length} ชิ้นได้อันดับคุณภาพหรือ conversion ต่ำกว่าค่าเฉลี่ย`,
      evidence: `Meta เทียบกับโฆษณาที่แข่งกลุ่มเป้าหมายเดียวกัน${engaged ? ` · ${engaged} ชิ้นในนี้การมีส่วนร่วม "สูงกว่าค่าเฉลี่ย"` : ""}`,
      suggest: engaged ? "คนสนใจโฆษณาแต่ไม่ไปต่อ — ทำหน้าปลายทางให้ตรงกับคำในโฆษณา เลี่ยงคำเร้าใจเกินจริง และลองชิ้นงานใหม่ 1–2 แบบ"
        : "ลองชิ้นงานใหม่ที่ตรงกลุ่มเป้าหมายกว่าเดิม และเลี่ยงพาดหัวเร้าใจเกินจริง", link: low[0].ad.link }, live, ...low.map((l) => l.ad));
  }
  // R5 ตำแหน่งโฆษณาแพง
  const hot = x.placements.filter((p) => p.hot);
  if (hot.length && x.accCpc) {
    recs.push({ id: "placement", sev: "warning", paused: x.counts.active === 0, link: null,
      title: `ตำแหน่งโฆษณา ${hot.length} จุดใช้งบมากแต่ได้คลิกน้อย`,
      evidence: hot.map((p) => `${p.label} ${baht(p.spend, 0)} (${Math.round(p.share * 100)}%) · ${p.cpc ? `${baht(p.cpc)}/คลิก` : "ไม่มีคลิก"}`).join(" · ") + ` · เฉลี่ยบัญชี ${baht(x.accCpc)}/คลิก`,
      suggest: "ถ้าเป้าหมายคือคลิก/ลีด ลองแยกชุดโฆษณาที่ไม่ใช้ตำแหน่งนี้เพื่อเทียบ — แคมเปญข้อความอาจได้ผลจากตำแหน่งนี้แม้คลิกน้อย ให้ดูต้นทุนต่อลีดประกอบ" });
  }
  // R6 อายุ 55+ ใช้งบมาก
  const old = x.age.filter((a) => a.age === "55-64" || a.age === "65+").reduce((s, a) => s + a.spend, 0);
  if (x.total.spend && old / x.total.spend >= RULE.oldShare) {
    const s = (k: string) => x.age.filter((a) => a.age === k).reduce((t, a) => t + a.spend, 0);
    recs.push({ id: "age", sev: "info", paused: false, link: null, title: `ผู้ชมอายุ 55+ ใช้งบ ${Math.round((old / x.total.spend) * 100)}%`,
      evidence: `55–64: ${baht(s("55-64"), 0)} · 65+: ${baht(s("65+"), 0)} · จากทั้งหมด ${baht(x.total.spend, 0)}`,
      suggest: "ถ้าลูกค้าเป้าหมายเป็นวัยทำงาน ลองแยกชุดโฆษณาตามช่วงอายุแล้วเทียบต้นทุนต่อผลลัพธ์ (ไม่ต้องตัดทิ้งทันที)" });
  }
  // R7 ใช้เงินเพิ่มมาก
  if (x.prev?.spend && x.total.spend / x.prev.spend - 1 >= RULE.spendGrowth) {
    recs.push({ id: "growth", sev: "info", paused: false, link: null, title: `ใช้เงินมากขึ้น ${Math.round((x.total.spend / x.prev.spend - 1) * 100)}% จากช่วงก่อน`,
      evidence: `${baht(x.prev.spend)} → ${baht(x.total.spend)}`, suggest: "เช็คว่าผลลัพธ์โตตามไหม (ดูกราฟผลลัพธ์รายวันด้านล่าง)" });
  }
  if (!x.counts.active) recs.push(noLiveRec(x.counts.campaigns));
  return recs.sort((a, b) => ORDER[a.sev] - ORDER[b.sev]);
}

/** ตัวเลขสรุปที่ส่งให้ Claude (ปุ่ม ✨) — ไม่มี token · ไม่มี ID · ชื่อแคมเปญย่อ */
export function summaryInput(d: InsightsData) {
  const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  const m = (x: Metrics) => ({ spend: r2(x.spend), impressions: x.impressions, reach: x.reach, frequency: r2(x.frequency),
    link_clicks: x.link_clicks, link_ctr_pct: r2(x.link_ctr), link_cpc: r2(x.link_cpc), cpm: r2(x.cpm) });
  const nodeOut = (n: Node): Json => ({
    name: short(n.name, 60), status: n.active ? "เปิด" : "ปิด", ...m(n.m),
    result: n.result ? { type: n.result.label, value: n.result.value, cost: r2(n.result.cost) } : null,
    ...(n.ranking ? { meta_rank: { quality: n.ranking.quality.text, engagement: n.ranking.engagement.text, conversion: n.ranking.conversion.text } } : {}),
    ...(n.children.length ? { children: n.children.slice(0, 8).map(nodeOut) } : {}),
  });
  return {
    currency: d.account.currency, period: d.period, previous: d.prev ? m(d.prev) : null, total: m(d.total),
    results: d.results.map((r) => ({ type: r.label, value: r.value, cost: r2(r.cost), campaigns: r.campaigns })),
    campaigns: d.campaigns.slice(0, 12).map(nodeOut),
    age_gender: d.age.map((a) => ({ age: a.age, gender: a.gender, spend: r2(a.spend), link_clicks: a.link_clicks })),
    placements: d.placements.slice(0, 10).map((p) => ({ placement: p.label, spend: r2(p.spend), share_pct: Math.round(p.share * 100), link_cpc: r2(p.cpc) })),
    rule_findings: d.recs.map((r) => ({ level: r.sev, title: r.title, evidence: r.evidence, paused: r.paused })),
    active_campaigns: d.counts.active,
  };
}
