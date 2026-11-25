import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { briefingSources } from "./agentEnv";
import { errMsg, get, getAll, Json, metaConfig } from "./meta";
import { amLink, resultName } from "./insights";
import type { BestWorst, BigNumber, Block, BriefingData, BriefingResult, BriefingSection, Fix, PageStat, Pick, PlatformKey, PlatformSeries } from "./briefingTypes";

/** หน้า Daily Briefing — ข้อมูล "เมื่อวาน" ของทุกพอร์ต อ่านอย่างเดียวจาก Meta (ads_read + เพจ + IG)
 *  กฎ: ใช้ตัวเลขจริงจาก Meta เท่านั้น · ดึงตัวไหนไม่ได้ → บอกว่าดึงไม่ได้ ห้ามเดา · token อยู่ฝั่ง server เท่านั้น
 *  ผลเก็บไว้ 10 นาที (โควตา Meta นับรวมทั้งบัญชี — กันแย่งกับการสร้างโฆษณา) */

const TTL_MS = 10 * 60_000;
const MIN_REFRESH_MS = 2 * 60_000;
const gc = globalThis as unknown as { __adsBriefing?: { at: number; data: BriefingData }; __adsBriefingPull?: Promise<BriefingResult> };

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
const num = (v: unknown) => Number(v ?? 0) || 0;
const baht = (v: number) => `฿${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (v: number) => Math.round(v).toLocaleString("en-US");
const clip = (s: string, k = 70) => (s.length > k ? s.slice(0, k - 1) + "…" : s);

function friendly(msg: string): string {
  const code = Number(msg.match(/\(code (\d+)\)/)?.[1] ?? 0);
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014))
    return "Meta จำกัดการเรียกข้อมูลของบัญชีนี้ชั่วคราว (เรียกถี่เกินไป) — รอ 5–10 นาทีแล้วกด ↻ ดึงใหม่";
  return msg;
}
const fail = (why: string): { ok: false; error: string } => ({ ok: false, error: friendly(why) });

/** วันที่ (YYYY-MM-DD) ตามเขตเวลา tz */
function localDay(tz: string, d: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function shiftDay(d: string, by: number) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + by);
  return t.toISOString().slice(0, 10);
}
const unix = (d: string) => String(Math.floor(Date.parse(d + "T00:00:00Z") / 1000));

/** ผลลัพธ์ของแถว insights (ฟิลด์ results ของ Meta)
 *  none = ไม่มีชนิดผลลัพธ์ · perK = วัดเป็นการเข้าถึง/แสดงผล (ไม่นับรวมเป็น "ผลลัพธ์") · count = นับได้ */
type Res = { kind: "none" } | { kind: "perK" } | { kind: "count"; value: number; short: string };
function resOf(r: Json): Res {
  const x = (r.results as Json[] | undefined)?.[0];
  if (!x?.indicator) return { kind: "none" };
  const [, , short, per] = resultName(String(x.indicator));
  if (per !== 1) return { kind: "perK" };
  return { kind: "count", value: num(x.values?.[0]?.value), short };
}

// ---------- 3 ตัวเลขใหญ่ (ระดับแคมเปญ รายวัน 8 วัน) ----------
interface Day { spend: number; results: number; resultSpend: number; perKSpend: number; mix: Map<string, number> }
const emptyDay = (): Day => ({ spend: 0, results: 0, resultSpend: 0, perKSpend: 0, mix: new Map() });
const cprOf = (d: Day) => (d.results > 0 ? d.resultSpend / d.results : null);

const PLATFORMS: { key: PlatformKey; label: string }[] = [
  { key: "facebook", label: "Facebook" }, { key: "instagram", label: "Instagram" }, { key: "other", label: "อื่น ๆ" },
];
const platformOf = (p: unknown): PlatformKey => (p === "facebook" || p === "instagram" ? p : "other");

function addRow(d: Day, row: Json) {
  const spend = num(row.spend), res = resOf(row);
  d.spend += spend;
  if (res.kind === "count") {
    d.results += res.value;
    d.resultSpend += spend;
    if (res.value) d.mix.set(res.short, (d.mix.get(res.short) ?? 0) + res.value);
  } else if (res.kind === "perK") d.perKSpend += spend;
}

/** คำขอเดียว: ระดับแคมเปญ × รายวัน × แพลตฟอร์ม (publisher_platform) → ยอดรวม + แยก Facebook / Instagram / อื่น ๆ */
async function pullAds(base: string, token: string, act: string, y: string): Promise<Block<{ big: BigNumber[]; mix: string; days: string[]; platforms: PlatformSeries[] }>> {
  const r = await getAll(`${base}/${act}/insights?${qs({
    level: "campaign", time_increment: "1", time_range: JSON.stringify({ since: shiftDay(y, -7), until: y }), breakdowns: "publisher_platform",
    fields: "campaign_id,spend,results", limit: "500", access_token: token,
  })}`);
  if (!r.ok) return fail(`อ่านผลโฆษณาไม่ได้: ${r.error}`);
  const days = new Map<string, Day>();
  const plat = new Map<string, Day>();   // key = แพลตฟอร์ม|วันที่
  for (const row of r.rows) {
    const d = days.get(row.date_start) ?? emptyDay();
    days.set(row.date_start, d);
    addRow(d, row);
    const pk = `${platformOf(row.publisher_platform)}|${row.date_start}`;
    const p = plat.get(pk) ?? emptyDay();
    plat.set(pk, p);
    addRow(p, row);
  }
  const dates = Array.from({ length: 8 }, (_, i) => shiftDay(y, -7 + i));
  const platforms: PlatformSeries[] = PLATFORMS.map(({ key, label }) => {
    const ds = dates.map((d) => plat.get(`${key}|${d}`) ?? emptyDay());
    return { key, label, spend: ds.map((d) => d.spend), results: ds.map((d) => d.results), cpr: ds.map(cprOf) };
  }).filter((p) => p.key !== "other" || p.spend.some((v) => v > 0));
  // Meta ไม่ส่งแถวของวันที่ไม่ได้ใช้เงิน → วันนั้นใช้ ฿0 จริง
  const day = (d: string) => days.get(d) ?? emptyDay();
  const yd = day(y), pd = day(shiftDay(y, -1));
  const week = Array.from({ length: 7 }, (_, i) => day(shiftDay(y, -7 + i)));
  const sum = (f: (d: Day) => number) => week.reduce((s, d) => s + f(d), 0);
  const wRes = sum((d) => d.results), wRS = sum((d) => d.resultSpend);
  const mix = [...yd.mix].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${int(v)}`).join(" · ");
  const big: BigNumber[] = [
    { key: "spend", label: "ค่าโฆษณาที่ใช้", unit: "baht", lowerIsBetter: false, now: yd.spend, prev: pd.spend, avg7: sum((d) => d.spend) / 7, note: "รวมทุกแคมเปญในบัญชี" },
    {
      key: "results", label: "ผลลัพธ์ (ทักแชต/คลิก ฯลฯ)", unit: "count", lowerIsBetter: false, now: yd.results, prev: pd.results, avg7: wRes / 7,
      note: mix || (yd.perKSpend > 0 ? "แคมเปญที่ใช้เงินวัดผลเป็นการเข้าถึง — ไม่นับเป็นผลลัพธ์" : "เมื่อวานไม่มีผลลัพธ์"),
    },
    {
      key: "cpr", label: "ต้นทุนต่อผลลัพธ์", unit: "baht", lowerIsBetter: true, now: cprOf(yd), prev: cprOf(pd), avg7: wRes > 0 ? wRS / wRes : null,
      note: "ค่าโฆษณาของแคมเปญที่นับผลลัพธ์ ÷ ผลลัพธ์",
    },
  ];
  return { ok: true, big, mix, days: dates, platforms };
}

// ---------- โฆษณาดีสุด/แย่สุดของเมื่อวาน ----------
async function pullAdPicks(base: string, token: string, act: string, y: string): Promise<Block<BestWorst> & { worstZero?: { name: string; spend: number } }> {
  const r = await getAll(`${base}/${act}/insights?${qs({
    level: "ad", time_range: JSON.stringify({ since: y, until: y }), fields: "ad_id,ad_name,spend,results", limit: "500", access_token: token,
  })}`);
  if (!r.ok) return fail(`อ่านผลรายโฆษณาไม่ได้: ${r.error}`);
  const ads = r.rows.map((x) => ({ id: String(x.ad_id), name: String(x.ad_name ?? x.ad_id), spend: num(x.spend), res: resOf(x) })).filter((a) => a.spend > 0);
  if (!ads.length) return { ok: true, best: null, worst: null, note: "เมื่อวานไม่มีโฆษณาที่ใช้เงิน" };
  type A = (typeof ads)[number];
  const pick = (a: A): Pick => {
    const res = a.res;
    const detail = res.kind === "count" && res.value > 0
      ? `ใช้ ${baht(a.spend)} · ได้ ${res.short} ${int(res.value)} · ${baht(a.spend / res.value)} ต่อ${res.short}`
      : res.kind === "perK" ? `ใช้ ${baht(a.spend)} · วัดผลเป็นการเข้าถึง` : `ใช้ ${baht(a.spend)} · ยังไม่มีผลลัพธ์`;
    return { name: a.name, detail, link: amLink(act, "ad", a.id) };
  };
  const cpr = (a: A) => (a.res.kind === "count" && a.res.value > 0 ? a.spend / a.res.value : Infinity);
  const withRes = ads.filter((a) => cpr(a) < Infinity).sort((a, b) => cpr(a) - cpr(b));
  const zero = ads.filter((a) => a.res.kind === "none" || (a.res.kind === "count" && a.res.value === 0)).sort((a, b) => b.spend - a.spend);
  const best = withRes[0] ?? null;
  const worst = zero[0] ?? (withRes.length > 1 ? withRes[withRes.length - 1] : null);
  const note = !best && !worst ? "โฆษณาที่ใช้เงินเมื่อวานวัดผลเป็นการเข้าถึงทั้งหมด — ไม่มีตัวให้จัดอันดับ"
    : !worst ? "มีโฆษณาที่ได้ผลลัพธ์ตัวเดียว — ยังไม่มีตัวให้เทียบ" : null;
  return { ok: true, best: best && pick(best), worst: worst && pick(worst), note, worstZero: zero[0] && { name: zero[0].name, spend: zero[0].spend } };
}

// ---------- เพจ: โพสต์ดีสุด/แย่สุด + สถิติเพจ ----------
async function pullPosts(base: string, pageToken: string, page: string, y: string, tz: string): Promise<Block<BestWorst & { count: number }>> {
  const url = (fields: string) => `${base}/${page}/published_posts?${qs({ fields, since: unix(shiftDay(y, -1)), limit: "50", access_token: pageToken })}`;
  const yesterdayOnly = (rows: Json[]) => rows.filter((p) => localDay(tz, new Date(String(p.created_time).replace(/\+0000$/, "Z"))) === y);
  const r = await getAll(url("id,created_time,message,permalink_url,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares"), 3);
  if (!r.ok) {
    // ยอดถูกใจ/คอมเมนต์ต้องใช้สิทธิ์ pages_read_user_content (code 10) — ไม่มี → ยังนับจำนวนโพสต์ได้ แต่จัดอันดับไม่ได้ (ไม่เดา)
    if (!/\(code 10\)/.test(r.error ?? "")) return fail(`อ่านโพสต์ของเพจไม่ได้: ${r.error}`);
    const basic = await getAll(url("id,created_time"), 3);
    if (!basic.ok) return fail(`อ่านโพสต์ของเพจไม่ได้: ${basic.error}`);
    const count = yesterdayOnly(basic.rows).length;
    return {
      ok: true, count, best: null, worst: null,
      note: count ? `เมื่อวานโพสต์ ${count} โพสต์ — จัดอันดับไม่ได้: token ไม่มีสิทธิ์อ่านยอดถูกใจ/คอมเมนต์ (pages_read_user_content)` : "เมื่อวานเพจไม่ได้โพสต์ใหม่",
    };
  }
  const posts = yesterdayOnly(r.rows).map((p) => {
    const re = num(p.reactions?.summary?.total_count), co = num(p.comments?.summary?.total_count), sh = num(p.shares?.count);
    return { score: re + co + sh, pick: { name: clip(String(p.message ?? "").replace(/\s+/g, " ").trim() || "(โพสต์ไม่มีข้อความ)"), detail: `ถูกใจ/แสดงความรู้สึก ${int(re)} · คอมเมนต์ ${int(co)} · แชร์ ${int(sh)}`, link: String(p.permalink_url ?? `https://www.facebook.com/${p.id}`) } };
  }).sort((a, b) => b.score - a.score);
  if (!posts.length) return { ok: true, count: 0, best: null, worst: null, note: "เมื่อวานเพจไม่ได้โพสต์ใหม่" };
  return {
    ok: true, count: posts.length, best: posts[0].pick, worst: posts.length > 1 ? posts[posts.length - 1].pick : null,
    note: posts.length > 1 ? null : "เมื่อวานมีโพสต์เดียว — ยังไม่มีตัวให้เทียบ",
  };
}

const PAGE_METRICS: [string, string][] = [
  ["page_media_view", "ยอดดูเนื้อหาเพจ"],
  ["page_post_engagements", "การมีส่วนร่วมกับโพสต์"],
  ["page_daily_follows_unique", "ผู้ติดตามใหม่"],
];
async function pullPageStats(base: string, pageToken: string, page: string, y: string): Promise<Block<{ rows: PageStat[]; note: string }>> {
  const r = await get(`${base}/${page}/insights?${qs({
    metric: PAGE_METRICS.map((m) => m[0]).join(","), period: "day", since: shiftDay(y, -7), until: shiftDay(y, 2), access_token: pageToken,
  })}`);
  if (!r.ok) return fail(`อ่านสถิติเพจไม่ได้: ${errMsg(r.body)}`);
  const data = (r.body.data ?? []) as Json[];
  if (!data.length) return fail("Meta ไม่ส่งตัวเลขสถิติของเพจนี้กลับมา");
  // ค่ารายวันของเพจ: end_time = เที่ยงคืนเวลาแปซิฟิกของวันถัดไป → ลบ 1 วันได้วันของค่านั้น
  const rows = PAGE_METRICS.map(([key, label]): PageStat => {
    const vals = new Map<string, number>();
    for (const v of (data.find((m) => m.name === key)?.values ?? []) as Json[]) vals.set(shiftDay(String(v.end_time).slice(0, 10), -1), num(v.value));
    const at = (d: string) => (vals.has(d) ? vals.get(d)! : null);
    const week = Array.from({ length: 7 }, (_, i) => at(shiftDay(y, -7 + i)));
    return { label, now: at(y), prev: at(shiftDay(y, -1)), avg7: week.every((v) => v !== null) ? week.reduce((s, v) => s + (v ?? 0), 0) / 7 : null };
  });
  return { ok: true, rows, note: "Meta นับวันของเพจตามเวลาแปซิฟิก — ตัวเลขของเมื่อวานครบหลัง 15:00 น. เวลาไทย" };
}

async function pullInstagram(base: string, token: string, ig: { id: string; username: string } | null, y: string, tz: string): Promise<Block<BestWorst & { username: string; count: number }>> {
  if (!ig) return fail("ดึงข้อมูล Instagram ไม่ได้ — ยังไม่ได้ผูกบัญชี IG กับเพจ");
  const r = await getAll(`${base}/${ig.id}/media?${qs({ fields: "id,caption,timestamp,permalink,like_count,comments_count", limit: "50", access_token: token })}`, 2);
  if (!r.ok) return fail(`ดึงข้อมูล Instagram ไม่ได้: ${r.error}`);
  const media = r.rows.filter((m) => localDay(tz, new Date(String(m.timestamp).replace(/\+0000$/, "Z"))) === y).map((m) => {
    const li = num(m.like_count), co = num(m.comments_count);
    return { score: li + co, pick: { name: clip(String(m.caption ?? "").replace(/\s+/g, " ").trim() || "(ไม่มีแคปชัน)"), detail: `ถูกใจ ${int(li)} · คอมเมนต์ ${int(co)}`, link: String(m.permalink) } };
  }).sort((a, b) => b.score - a.score);
  if (!media.length) return { ok: true, username: ig.username, count: 0, best: null, worst: null, note: "เมื่อวาน IG ไม่ได้โพสต์ใหม่" };
  return {
    ok: true, username: ig.username, count: media.length, best: media[0].pick, worst: media.length > 1 ? media[media.length - 1].pick : null,
    note: media.length > 1 ? null : "เมื่อวาน IG มีโพสต์เดียว — ยังไม่มีตัวให้เทียบ",
  };
}

// ---------- วันนี้ต้องแก้อะไร (ไม่เกิน 3 ข้อ · ทุกข้อบอกว่ามาจากตัวเลขไหน) ----------
function fixesOf(s: BriefingSection, worstZero?: { name: string; spend: number }): Fix[] {
  const out: Fix[] = [];
  if (s.ads.ok) {
    const [spend, results, cpr] = s.ads.big;
    const sp = spend.now ?? 0, avgSp = spend.avg7 ?? 0, rs = results.now ?? 0, avgRs = results.avg7 ?? 0;
    if (worstZero && worstZero.spend >= 300)
      out.push({ text: `พิจารณาปิดหรือแก้โฆษณา “${clip(worstZero.name, 40)}” — ใช้ไป ${baht(worstZero.spend)} แต่ไม่ได้ผลลัพธ์`, from: "โฆษณาแย่สุดของเมื่อวาน" });
    if (sp > 0 && rs === 0 && results.note !== "แคมเปญที่ใช้เงินวัดผลเป็นการเข้าถึง — ไม่นับเป็นผลลัพธ์")
      out.push({ text: `ใช้ค่าโฆษณา ${baht(sp)} แต่ไม่ได้ผลลัพธ์เลย — เช็กโฆษณาที่กำลังวิ่งและปลายทาง (แชต/ลิงก์)`, from: "ค่าโฆษณาที่ใช้ + ผลลัพธ์ เมื่อวาน" });
    if (cpr.now !== null && cpr.avg7 !== null && cpr.now > cpr.avg7 * 1.3)
      out.push({ text: `ต้นทุนต่อผลลัพธ์แพงขึ้น ${Math.round((cpr.now / cpr.avg7 - 1) * 100)}% จากเฉลี่ย 7 วัน — ดูว่าโฆษณาตัวไหนดันต้นทุนขึ้น`, from: "ต้นทุนต่อผลลัพธ์" });
    if (sp > 0 && avgRs > 0 && rs < avgRs * 0.7)
      out.push({ text: `ผลลัพธ์ลดลง ${Math.round((1 - rs / avgRs) * 100)}% จากเฉลี่ย 7 วัน — เช็กว่าชุดโฆษณาที่เคยได้ผลยังวิ่งอยู่`, from: "ผลลัพธ์" });
    if (sp === 0 && avgSp > 0)
      out.push({ text: `เมื่อวานโฆษณาไม่ได้ใช้เงินเลย (ปกติเฉลี่ย ${baht(avgSp)}/วัน) — เช็กสถานะแคมเปญและการชำระเงิน`, from: "ค่าโฆษณาที่ใช้" });
    if (sp === 0 && avgSp === 0)
      out.push({ text: "ไม่มีโฆษณาใช้เงินเลย 8 วันที่ผ่านมา — ถ้าตั้งใจยิงแอด ให้เปิดชุดโฆษณาที่เตรียมไว้", from: "ค่าโฆษณาที่ใช้ (฿0 ทั้งเมื่อวานและเฉลี่ย 7 วัน)" });
  }
  if (s.posts.ok && s.posts.count === 0)
    out.push({ text: "เมื่อวานเพจไม่ได้โพสต์ใหม่ — ลงโพสต์วันนี้อย่างน้อย 1 โพสต์", from: "จำนวนโพสต์ของเพจเมื่อวาน = 0" });
  return out.slice(0, 3);
}

// ---------- รวมต่อพอร์ต ----------
async function pullSection(src: { account: string; page: string; token: string }, base: string): Promise<{ s: BriefingSection; y: string }> {
  const { account, page, token } = src;
  const [acc, pg] = await Promise.all([
    get(`${base}/${account}?${qs({ fields: "name,timezone_name,business{name}", access_token: token })}`),
    get(`${base}/${page}?${qs({ fields: "name,link,picture{url},access_token,instagram_business_account{id,username}", access_token: token })}`),
  ]);
  const tz = acc.ok && acc.body.timezone_name ? String(acc.body.timezone_name) : "Asia/Bangkok";
  const y = shiftDay(localDay(tz), -1);
  const pageToken = pg.ok ? String(pg.body.access_token ?? "") : "";
  const pageErr = !pg.ok ? `อ่านเพจไม่ได้: ${errMsg(pg.body)}` : !pageToken ? "token นี้ไม่มีสิทธิ์จัดการเพจ — อ่านโพสต์/สถิติเพจไม่ได้" : null;
  const igAcc = pg.ok && pg.body.instagram_business_account ? { id: String(pg.body.instagram_business_account.id), username: String(pg.body.instagram_business_account.username ?? "") } : null;

  const [ads, picks, posts, stats, ig] = await Promise.all([
    acc.ok ? pullAds(base, token, account, y) : Promise.resolve(fail(`อ่านบัญชีโฆษณาไม่ได้: ${errMsg(acc.body)}`)),
    acc.ok ? pullAdPicks(base, token, account, y) : Promise.resolve(fail(`อ่านบัญชีโฆษณาไม่ได้: ${errMsg(acc.body)}`)),
    pageErr ? Promise.resolve(fail(pageErr)) : pullPosts(base, pageToken, page, y, tz),
    pageErr ? Promise.resolve(fail(pageErr)) : pullPageStats(base, pageToken, page, y),
    pg.ok ? pullInstagram(base, token, igAcc, y, tz) : Promise.resolve(fail(`ดึงข้อมูล Instagram ไม่ได้: ${errMsg(pg.body)}`)),
  ]);
  // ตัดฟิลด์ภายใน (worstZero) ออกก่อนส่งให้หน้าเว็บ
  const adsOut: BriefingSection["ads"] = ads;
  const picksOut: BriefingSection["adPicks"] = picks.ok ? { ok: true, best: picks.best, worst: picks.worst, note: picks.note } : picks;
  const s: BriefingSection = {
    account,
    accountName: acc.ok ? String(acc.body.business?.name ?? acc.body.name ?? account) : account,
    page: pg.ok ? { name: String(pg.body.name ?? page), link: String(pg.body.link ?? `https://www.facebook.com/${page}`), picture: pg.body.picture?.data?.url ?? null } : null,
    ads: adsOut, adPicks: picksOut, posts, instagram: ig, pageStats: stats, fixes: [],
  };
  s.fixes = fixesOf(s, picks.ok ? picks.worstZero : undefined);
  return { s, y };
}

type Snap = { at: number; data: BriefingData };
const SNAP_FILE = path.join(process.cwd(), "data", "briefing-last.json");

/** ชุดล่าสุดเก็บลงไฟล์ด้วย — ปิดแอปแล้วเปิดใหม่ยังเห็นชุดที่อัปเดตไว้ (ไม่มี token ในไฟล์ · data/ ไม่เข้า git) */
async function loadSnap(): Promise<Snap | undefined> {
  if (gc.__adsBriefing) return gc.__adsBriefing;
  try {
    const s = JSON.parse(await fs.readFile(SNAP_FILE, "utf8")) as Snap;
    if (s?.data?.ok && Number.isFinite(s.at)) return (gc.__adsBriefing = s);
  } catch { /* ยังไม่มีไฟล์ */ }
  return undefined;
}
async function saveSnap(s: Snap) {
  gc.__adsBriefing = s;
  await fs.mkdir(path.dirname(SNAP_FILE), { recursive: true });
  await fs.writeFile(SNAP_FILE + ".tmp", JSON.stringify(s), "utf8");
  await fs.rename(SNAP_FILE + ".tmp", SNAP_FILE);
}

/** open = เปิดหน้า · fresh = ปุ่ม ↻ ดึงใหม่ · auto = ตัวจับเวลา (ดึงใหม่เสมอ)
 *  keep = เปิดตั้งเวลาไว้ → เปิดหน้าแล้วใช้ชุดที่อัปเดตไว้ของวันนี้เลย ไม่ต้องรอ Meta (ไม่ใช้อายุ 10 นาที) */
export async function getBriefing(mode: "open" | "fresh" | "auto", keep = false): Promise<BriefingResult> {
  const hit = await loadSnap();
  const age = hit ? Date.now() - hit.at : Infinity;
  // วันเปลี่ยน (เลยเที่ยงคืน) → ชุดเดิมเป็นของ "เมื่อวาน" ที่ไม่ใช่แล้ว ต้องดึงใหม่
  const sameDay = hit && shiftDay(localDay("Asia/Bangkok"), -1) === hit.data.yesterday;
  if (hit && sameDay) {
    if (mode === "open" && (keep || age < TTL_MS)) return hit.data;
    if (mode === "fresh" && age < MIN_REFRESH_MS) return hit.data;
  }
  // ดึงซ้อนกัน (ตัวจับเวลา + กดดึงใหม่พร้อมกัน) → ใช้คำขอเดียวกัน ไม่ยิง Meta ซ้ำ
  gc.__adsBriefingPull ??= pull(hit).finally(() => { gc.__adsBriefingPull = undefined; });
  return gc.__adsBriefingPull;
}

async function pull(hit: Snap | undefined): Promise<BriefingResult> {
  const list = await briefingSources();
  if (!list.length) return { ok: false, error: "ยังไม่มีพอร์ตที่ตั้งครบ (token + บัญชีโฆษณา + เพจ) — ตั้งได้ที่แท็บ ＋ สร้างโฆษณา → ตั้งค่า Agent" };
  const { base } = metaConfig();
  try {
    const parts = await Promise.all(list.map((src) => pullSection(src, base)));
    const data: BriefingData = { ok: true, at: new Date().toISOString(), yesterday: parts[0].y, sections: parts.map((p) => p.s) };
    await saveSnap({ at: Date.now(), data });
    return data;
  } catch (e) {
    const why = friendly((e as Error).message);
    if (hit) return { ...hit.data, stale: why };
    return { ok: false, error: why };
  }
}
