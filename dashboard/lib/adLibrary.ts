import "server-only";
import type { Browser, Page } from "playwright-core";
import { adLibraryKeywordUrl, adLibraryPageUrl, adLibrarySearchUrl } from "./competitorsTypes";
import type { CompetitorAd, PageCandidate } from "./competitorsTypes";

/** อ่าน Meta Ad Library (ไทย · แอดที่รันอยู่) แบบไม่ล็อกอิน ด้วย Chrome ในเครื่อง (ไม่มีหน้าจอ)
 *  Ad Library API ไม่คืนแอดเชิงพาณิชย์ในไทย → อ่านข้อมูลที่หน้าเว็บโหลดมาแทน (JSON ใน HTML + graphql)
 *  ไม่ล็อกอิน ไม่ใช้ token ไม่แตะ facebook.com/developers · ไม่โหลดรูป/วิดีโอ (เร็วขึ้น + ไม่เก็บไฟล์คนอื่น) */

const pageUrl = adLibraryPageUrl, keywordUrl = adLibraryKeywordUrl, looseUrl = adLibrarySearchUrl;

export type FetchResult = { ok: true; total: number | null; ads: CompetitorAd[] } | { ok: false; error: string };

export async function openBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    try {
      return await chromium.launch({ channel: "msedge", headless: true });
    } catch {
      throw new Error("เปิด Chrome/Edge ในเครื่องไม่ได้ — ต้องติดตั้ง Google Chrome หรือใช้ช่องวางเองแทน");
    }
  }
}

/** หา array หลัง "collated_results":[ แล้ว parse (นับวงเล็บโดยข้ามข้อความในเครื่องหมายคำพูด) */
function collated(text: string): unknown[] {
  const out: unknown[] = [];
  const key = '"collated_results":[';
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
    const s = at + key.length - 1;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    try { out.push(...(JSON.parse(text.slice(s, end + 1)) as unknown[])); } catch { /* ชิ้นที่ไม่ครบ */ }
  }
  return out;
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const isTemplate = (s: string | null) => !s || /\{\{[^}]+\}\}/.test(s);

function toAd(r: Raw): CompetitorAd | null {
  const id = str(r.ad_archive_id);
  if (!id || !/^\d+$/.test(id)) return null;
  const snap = (r.snapshot ?? {}) as Raw;
  const cards = Array.isArray(snap.cards) ? (snap.cards as Raw[]) : [];
  let body = str((snap.body as Raw | null)?.text);
  if (isTemplate(body)) body = str(cards[0]?.body) ?? body;
  const start = typeof r.start_date === "number" ? new Date(r.start_date * 1000).toISOString().slice(0, 10) : null;
  const plats = Array.isArray(r.publisher_platform) ? (r.publisher_platform as unknown[]).filter((p): p is string => typeof p === "string") : [];
  return {
    id,
    pageId: str(r.page_id) ?? str(snap.page_id),
    pageName: str(snap.page_name) ?? "?",
    start,
    platforms: plats,
    body: isTemplate(body) ? "" : (body ?? ""),
    title: isTemplate(str(snap.title)) ? (str(cards[0]?.title) ?? null) : str(snap.title),
    cta: str(snap.cta_text),
    link: str(snap.link_url) ?? str(cards[0]?.link_url),
    format: str(snap.display_format),
    copies: Math.max(1, Number(r.collation_count) || 1),
  };
}

/** เปิด url → เลื่อนลงจนได้ครบหรือไม่มีเพิ่ม (สูงสุด maxAds) → แอดทั้งหมดที่หน้าเว็บโหลดมา */
async function grab(browser: Browser, url: string, maxAds: number): Promise<FetchResult> {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  try {
    await ctx.route("**/*", (r) => (["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    const page: Page = await ctx.newPage();
    const chunks: string[] = [];
    const pending: Promise<void>[] = [];
    page.on("response", (res) => {
      const u = res.url();
      if (!u.includes("/api/graphql") && !u.includes("/ads/library")) return;
      pending.push(res.text().then((t) => { if (t.includes("collated_results") || t.includes("search_results_connection")) chunks.push(t); }, () => {}));
    });
    // หน้าแรกอาจตอบ 403 พร้อมสคริปต์ตรวจเบราว์เซอร์ แล้วโหลดหน้าจริงต่อเอง → ไม่ตัดสินจากสถานะ ดูว่ามีข้อมูลแอดมาไหม
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    for (let i = 0; i < 8 && !chunks.length; i++) {
      await page.waitForTimeout(1500);
      await Promise.all(pending.splice(0));
    }
    await page.waitForTimeout(2000);

    const count = async () => {
      await Promise.all(pending.splice(0));
      return new Set(chunks.flatMap(collated).map((r) => (r as Raw).ad_archive_id)).size;
    };
    let seen = await count(), still = 0;
    for (let i = 0; i < 12 && seen < maxAds && still < 2; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1800);
      const n = await count();
      still = n === seen ? still + 1 : 0;
      seen = n;
    }
    await Promise.all(pending.splice(0));

    const all = chunks.join("\n");
    if (/"xfb_ad_library_is_captcha_required":true/.test(all))
      return { ok: false, error: "Facebook ขอให้ยืนยันว่าไม่ใช่บอท (captcha) — รอสักพักแล้วสแกนใหม่ หรือใช้ช่องวางเอง" };
    if (!all.includes("search_results_connection")) {
      const login = /login|checkpoint/.test(page.url());
      return { ok: false, error: login ? "Facebook ขอให้ล็อกอินก่อนดู Ad Library — ใช้ช่องวางเองแทน" : "หน้า Ad Library ไม่ส่งข้อมูลแอดมา (หน้าเว็บอาจเปลี่ยน) — ใช้ช่องวางเองแทน" };
    }
    const total = Number(all.match(/"search_results_connection":\{"count":(\d+)/)?.[1] ?? NaN);
    const byId = new Map<string, CompetitorAd>();
    for (const r of chunks.flatMap(collated)) {
      const ad = toAd(r as Raw);
      if (ad && !byId.has(ad.id)) byId.set(ad.id, ad);
    }
    return { ok: true, total: Number.isFinite(total) ? total : null, ads: [...byId.values()].slice(0, maxAds) };
  } catch (e) {
    const m = (e as Error).message ?? "";
    return { ok: false, error: /Timeout/i.test(m) ? "Ad Library โหลดไม่ทันเวลา (45 วิ) — ลองสแกนใหม่" : `ดึง Ad Library ไม่ได้: ${m.slice(0, 160)}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** แอดที่รันอยู่ของเพจ (ทั้งหมดที่เพจนั้นลง ไม่ใช่แค่ที่มีคำค้น) */
export async function pageAds(browser: Browser, pageId: string): Promise<FetchResult> {
  const r = await grab(browser, pageUrl(pageId), 60);
  // view_all_page_id คืนแอดของเพจนี้อย่างเดียว — กันเผื่อมีเพจอื่นปน
  return r.ok ? { ...r, ads: r.ads.filter((a) => !a.pageId || a.pageId === pageId) } : r;
}

/** ค้นวลีตรงตัว → แอดของทุกเพจที่ข้อความมีวลีนี้ */
export function keywordAds(browser: Browser, q: string): Promise<FetchResult> {
  return grab(browser, keywordUrl(q), 60);
}

/** หาเพจจากชื่อ: ค้นคำนี้ → เพจที่มีแอดรันอยู่ เรียงให้ชื่อที่ตรงขึ้นก่อน */
export async function findPages(browser: Browser, name: string): Promise<{ ok: true; pages: PageCandidate[] } | { ok: false; error: string }> {
  const r = await grab(browser, looseUrl(name), 40);
  if (!r.ok) return r;
  const want = name.toLowerCase().replace(/\s+/g, "");
  const m = new Map<string, PageCandidate>();
  for (const a of r.ads) {
    if (!a.pageId) continue;
    const c = m.get(a.pageId) ?? { pageId: a.pageId, name: a.pageName, ads: 0 };
    c.ads++;
    m.set(a.pageId, c);
  }
  const score = (c: PageCandidate) => (c.name.toLowerCase().replace(/\s+/g, "").includes(want) ? 0 : 1);
  return { ok: true, pages: [...m.values()].sort((a, b) => score(a) - score(b) || b.ads - a.ads).slice(0, 8) };
}

/* ---------------- ช่องวางเอง: ข้อความทั้งหน้า (Ctrl+A) จาก Ad Library ภาษาไทยหรืออังกฤษ ---------------- */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6, "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
};
function pastedDate(d: string, mon: string, y: string): string | null {
  const m = MONTHS[mon.toLowerCase().slice(0, 3)] ?? MONTHS[mon];
  let year = Number(y);
  if (year > 2400) year -= 543;            // พ.ศ.
  if (!m || !year) return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
}

export type PasteResult = { ok: true; total: number | null; ads: CompetitorAd[] } | { ok: false; none: boolean; error: string };

export function parsePasted(text: string, pageName: string): PasteResult {
  const t = text.replace(/\r/g, "").replace(/​/g, "");
  const totalM = t.match(/~?([\d,]+) results?\b/) ?? t.match(/ผลลัพธ์(?:ประมาณ)?\s*([\d,]+)\s*รายการ/);
  const total = totalM ? Number(totalM[1].replace(/,/g, "")) : null;
  const parts = t.split(/\n(?:Library ID|ID คลัง)\s*:\s*/).slice(1);
  if (!parts.length) {
    if (/No ads match|ไม่มีโฆษณา|ไม่พบโฆษณา/.test(t) || total === 0) return { ok: false, none: true, error: "ข้อความที่วางบอกว่าไม่มีแอดที่รันอยู่" };
    return { ok: false, none: false, error: "ไม่พบแอดในข้อความที่วาง — เปิดหน้า Ad Library ของเจ้านี้ กด Ctrl+A แล้ว Ctrl+C ทั้งหน้า" };
  }
  const ads: CompetitorAd[] = [];
  for (const p of parts) {
    const L = p.split("\n").map((s) => s.trim()).filter(Boolean);
    const id = L[0]?.match(/^\d+/)?.[0];
    if (!id) continue;
    const dm = p.match(/(?:Started running on|(?:ได้)?เริ่มเผยแพร่เมื่อ)\s+(\d{1,2})\s+(\S+)\s+(\d{4})/);
    const si = L.findIndex((s) => s === "Sponsored" || s === "ได้รับการสนับสนุน");
    const end = L.findIndex((s, i) => i > si && /^(Active|Inactive|กำลังใช้งาน|ไม่ได้ใช้งาน)$/.test(s));
    const body = si >= 0 ? L.slice(si + 1, end > 0 ? end : undefined).join("\n") : "";
    const copies = Number(p.match(/(\d+) ads use this creative/)?.[1] ?? 1);
    // แพลตฟอร์มเป็นไอคอน ข้อความที่คัดลอกไม่มีชื่อ → ว่าง
    ads.push({ id, pageId: null, pageName, start: dm ? pastedDate(dm[1], dm[2], dm[3]) : null, platforms: [], body, title: null, cta: null, link: null, format: null, copies });
  }
  if (!ads.length) return { ok: false, none: false, error: "แยกแอดจากข้อความที่วางไม่ได้" };
  return { ok: true, total, ads };
}
