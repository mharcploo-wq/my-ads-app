import "server-only";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { findPages, keywordAds, openBrowser, pageAds, parsePasted } from "./adLibrary";
import { runCreator } from "./creator";
import type {
  Angle, Competitor, CompetitorAd, CompetitorScan, CompetitorsState, CompetitorSummary, KeywordHit, KeywordScan,
  Longest, PageCandidate, SummaryRow,
} from "./competitorsTypes";

/** หน้าวิเคราะห์คู่แข่ง — เก็บค่าตั้ง + ผลสแกนรอบล่าสุดใน data/competitors.json (ข้อมูลสาธารณะจาก Ad Library ไม่มี token)
 *  สแกนเมื่อกดปุ่มเท่านั้น · ทำทีละเจ้า พักระหว่างเจ้า (ไม่ยิง Ad Library ถี่) · สแกนเสร็จ → Claude สรุปต่อทันที */

const FILE = path.join(process.cwd(), "data", "competitors.json");
const MAX_COMPETITORS = 15;
const MAX_KEYWORDS = 8;
const PAUSE_MS = 2500;

type Stored = Omit<CompetitorsState, "running">;
type Running = CompetitorsState["running"];

const DEFAULTS: Stored = {
  business: "รับเขียนโปรแกรม เว็บไซต์ AI และรับสร้างระบบ ERP ในประเทศไทย · เพจ Top Tech-Inter",
  competitors: [
    { pageId: "960716580449858", name: "JND WEB" },
    { pageId: "1102870896248239", name: "Limitcode Studio" },
    { pageId: "1131533303381815", name: "ByteMatrix" },
    { pageId: "1140231909163752", name: "Devy" },
    { pageId: "377393268800929", name: "iReadCustomer" },
  ],
  keywords: ["รับเขียนโปรแกรม", "ระบบ ERP"],
  scans: {},
  keywordScans: [],
  hits: [],
  lastScan: null,
  summary: null,
  summaryError: null,
};

const gc = globalThis as unknown as { __adsCompetitorsRun?: Running };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

async function load(): Promise<Stored> {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<Stored>;
    return {
      ...DEFAULTS,
      ...raw,
      competitors: Array.isArray(raw.competitors) ? raw.competitors : DEFAULTS.competitors,
      keywords: Array.isArray(raw.keywords) ? raw.keywords : DEFAULTS.keywords,
      scans: raw.scans && typeof raw.scans === "object" ? raw.scans : {},
      keywordScans: Array.isArray(raw.keywordScans) ? raw.keywordScans : [],
      hits: Array.isArray(raw.hits) ? raw.hits : [],
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

async function save(s: Stored) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE + ".tmp", JSON.stringify(s), "utf8");
  await fs.rename(FILE + ".tmp", FILE);
}

/** แก้ไฟล์ทีละคำขอ (สแกนเบื้องหลังกับการแก้ค่าตั้งไม่ทับกัน) */
const update = (fn: (s: Stored) => void) => serial(async () => { const s = await load(); fn(s); await save(s); return s; });

function longestOf(ads: CompetitorAd[]): Longest | null {
  const dated = ads.filter((a) => a.start).sort((a, b) => a.start!.localeCompare(b.start!));
  const a = dated[0];
  if (!a) return null;
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(a.start! + "T00:00:00+07:00")) / 86_400_000));
  return { id: a.id, start: a.start!, days, text: a.body.split("\n")[0].slice(0, 120) };
}

function view(s: Stored): CompetitorsState {
  const scans = Object.fromEntries(Object.entries(s.scans).map(([k, v]) => [k, { ...v, longest: v.status === "ok" ? longestOf(v.ads) : null }]));
  return { ...s, scans, running: gc.__adsCompetitorsRun ?? null };
}

export async function getCompetitors(): Promise<CompetitorsState> {
  return view(await load());
}

/* ---------------- ค่าตั้ง ---------------- */

export interface ConfigInput { business?: unknown; competitors?: unknown; keywords?: unknown }

export async function saveConfig(input: ConfigInput): Promise<{ ok: true; state: CompetitorsState } | { ok: false; error: string }> {
  const business = typeof input.business === "string" ? input.business.trim() : null;
  if (business !== null && business.length > 1000) return { ok: false, error: "คำอธิบายธุรกิจยาวเกิน 1,000 ตัวอักษร" };

  let competitors: Competitor[] | null = null;
  if (input.competitors !== undefined) {
    if (!Array.isArray(input.competitors)) return { ok: false, error: "รายชื่อคู่แข่งไม่ถูกต้อง" };
    competitors = [];
    for (const c of input.competitors as Record<string, unknown>[]) {
      const pageId = String(c?.pageId ?? "").trim(), name = String(c?.name ?? "").trim().slice(0, 120);
      if (!/^\d{5,20}$/.test(pageId) || !name) return { ok: false, error: "คู่แข่งต้องมี page_id (ตัวเลข) และชื่อ" };
      if (!competitors.some((x) => x.pageId === pageId)) competitors.push({ pageId, name });
    }
    if (competitors.length > MAX_COMPETITORS) return { ok: false, error: `ใส่คู่แข่งได้ไม่เกิน ${MAX_COMPETITORS} เจ้า (สแกนนานและยิง Ad Library ถี่เกินไป)` };
  }

  let keywords: string[] | null = null;
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords)) return { ok: false, error: "คำค้นไม่ถูกต้อง" };
    keywords = [...new Set((input.keywords as unknown[]).map((k) => String(k ?? "").replace(/["“”]/g, "").trim()).filter(Boolean))];
    if (keywords.some((k) => k.length < 2 || k.length > 60)) return { ok: false, error: "คำค้นต้องยาว 2–60 ตัวอักษร" };
    if (keywords.length > MAX_KEYWORDS) return { ok: false, error: `ใส่คำค้นได้ไม่เกิน ${MAX_KEYWORDS} คำ` };
  }

  const s = await update((s) => {
    if (business !== null) s.business = business;
    if (competitors) {
      s.competitors = competitors;
      const keep = new Set(competitors.map((c) => c.pageId));
      for (const k of Object.keys(s.scans)) if (!keep.has(k)) delete s.scans[k];
      s.hits = s.hits.filter((h) => !keep.has(h.pageId));
      for (const c of competitors) if (s.scans[c.pageId]) s.scans[c.pageId].name = c.name;
    }
    if (keywords) s.keywords = keywords;
  });
  return { ok: true, state: view(s) };
}

/* ---------------- งานเบื้องหลัง (สแกน / สรุป) — ทีละงาน ---------------- */

function begin(kind: "scan" | "summary", step: string): boolean {
  if (gc.__adsCompetitorsRun) return false;
  gc.__adsCompetitorsRun = { kind, step, startedAt: now() };
  return true;
}
const step = (t: string) => { if (gc.__adsCompetitorsRun) gc.__adsCompetitorsRun.step = t; };
const busyText = () => (gc.__adsCompetitorsRun?.kind === "scan" ? "กำลังสแกนอยู่ — รอให้เสร็จก่อน" : "Claude กำลังสรุปอยู่ — รอให้เสร็จก่อน");

/** เทียบรอบก่อน: ใหม่ = id ที่รอบก่อนไม่มี · หายไป = id รอบก่อนที่รอบนี้ไม่มี (รอบก่อนต้องอ่านได้จริงถึงจะเทียบ) */
function diff(prev: CompetitorScan | undefined, ads: CompetitorAd[]) {
  if (!prev || prev.status === "error") return { newIds: [], gone: 0 };
  const before = new Set(prev.ads.map((a) => a.id)), after = new Set(ads.map((a) => a.id));
  return { newIds: ads.filter((a) => !before.has(a.id)).map((a) => a.id), gone: [...before].filter((id) => !after.has(id)).length };
}

export async function startScan(): Promise<{ ok: true; state: CompetitorsState } | { ok: false; error: string }> {
  const s = await load();
  if (!s.competitors.length && !s.keywords.length) return { ok: false, error: "ยังไม่มีคู่แข่งหรือคำค้นให้สแกน" };
  if (!begin("scan", "กำลังเปิด Chrome…")) return { ok: false, error: busyText() };
  void runScan().catch(() => {}).finally(() => { gc.__adsCompetitorsRun = null; });
  return { ok: true, state: view(s) };
}

async function runScan() {
  const cfg = await load();
  let browser;
  try {
    browser = await openBrowser();
  } catch (e) {
    await update((s) => { s.lastScan = { at: now(), error: (e as Error).message }; });
    return;
  }
  let failed = 0;
  try {
    for (const [i, c] of cfg.competitors.entries()) {
      step(`สแกน ${c.name} (${i + 1}/${cfg.competitors.length})`);
      const r = await pageAds(browser, c.pageId);
      await update((s) => {
        if (!s.competitors.some((x) => x.pageId === c.pageId)) return;   // ถูกลบระหว่างสแกน
        const prev = s.scans[c.pageId];
        if (!r.ok) {
          failed++;
          s.scans[c.pageId] = { pageId: c.pageId, name: c.name, status: "error", source: "auto", at: now(), total: null, ads: [], error: r.error, newIds: [], gone: 0 };
          return;
        }
        s.scans[c.pageId] = {
          pageId: c.pageId, name: c.name, status: r.ads.length ? "ok" : "none", source: "auto", at: now(),
          total: r.total, ads: r.ads, error: null, ...diff(prev, r.ads),
        };
      });
      await sleep(PAUSE_MS);
    }

    const hits = new Map<string, KeywordHit>();
    const kwScans: KeywordScan[] = [];
    const mine = new Set(cfg.competitors.map((c) => c.pageId));
    for (const [i, k] of cfg.keywords.entries()) {
      step(`ค้นคำ "${k}" (${i + 1}/${cfg.keywords.length})`);
      const r = await keywordAds(browser, k);
      kwScans.push({ keyword: k, at: now(), total: r.ok ? r.total : null, error: r.ok ? null : r.error });
      if (r.ok) for (const a of r.ads) {
        if (!a.pageId || mine.has(a.pageId)) continue;
        const h = hits.get(a.pageId) ?? { pageId: a.pageId, name: a.pageName, ads: 0, keyword: k, sample: a.body.split("\n")[0].slice(0, 140) };
        h.ads++;
        hits.set(a.pageId, h);
      }
      await sleep(PAUSE_MS);
    }
    await update((s) => {
      const keep = new Set(s.competitors.map((c) => c.pageId));
      s.keywordScans = kwScans;
      s.hits = [...hits.values()].filter((h) => !keep.has(h.pageId)).sort((a, b) => b.ads - a.ads);
      s.lastScan = {
        at: now(),
        error: failed && failed === cfg.competitors.length ? "ดึงไม่ได้ทุกเจ้า — ดูเหตุผลที่แต่ละเจ้า แล้วใช้ช่องวางเอง" : null,
      };
    });
  } finally {
    await browser.close().catch(() => {});
  }
  step("Claude กำลังสรุป…");
  await runSummary();
}

export async function startSummary(): Promise<{ ok: true; state: CompetitorsState } | { ok: false; error: string }> {
  if (!begin("summary", "Claude กำลังสรุป…")) return { ok: false, error: busyText() };
  void runSummary().catch(() => {}).finally(() => { gc.__adsCompetitorsRun = null; });
  return { ok: true, state: view(await load()) };
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);

async function runSummary() {
  const s = await load();
  const withAds = s.competitors.map((c) => s.scans[c.pageId]).filter((x): x is CompetitorScan => !!x && x.status === "ok" && x.ads.length > 0);
  if (!withAds.length) {
    await update((x) => { x.summary = null; x.summaryError = "ยังไม่มีแอดคู่แข่งให้สรุป — สแกนก่อน หรือวางข้อความเอง"; });
    return;
  }
  const input = {
    business: s.business,
    competitors: withAds.map((c) => ({
      page_id: c.pageId, name: c.name, active_ads: c.total ?? c.ads.length,
      ads: c.ads.slice(0, 15).map((a) => ({ start: a.start, text: clip(a.body, 900), title: a.title, cta: a.cta, copies: a.copies })),
    })),
    competitors_without_ads: s.competitors.filter((c) => s.scans[c.pageId]?.status === "none").map((c) => c.name),
  };
  const tmp = path.join(os.tmpdir(), `ads-competitors-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = path.join(tmp, "competitors.json");
    await fs.writeFile(file, JSON.stringify(input), "utf8");
    const r = await runCreator<{ success: boolean; error: string | null; model?: string; rows?: { page_id: string; hooks: string[]; offer: string }[]; angles?: Angle[]; note?: string }>(
      "claude", ["--competitors-summary-json", file], 150_000);
    if (!r.success) {
      await update((x) => { x.summaryError = r.error ?? "Claude สรุปไม่สำเร็จ"; });
      return;
    }
    const names = new Map(withAds.map((c) => [c.pageId, c.name]));
    const rows: SummaryRow[] = (r.rows ?? []).filter((x) => names.has(x.page_id)).map((x) => ({ pageId: x.page_id, name: names.get(x.page_id)!, hooks: x.hooks, offer: x.offer }));
    const summary: CompetitorSummary = { at: now(), model: r.model ?? "", rows, angles: r.angles ?? [], note: r.note ?? "" };
    await update((x) => { x.summary = summary; x.summaryError = null; });
  } catch (e) {
    await update((x) => { x.summaryError = (e as Error).message; });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------- ช่องวางเอง ---------------- */

export async function pasteAds(pageId: string, text: string): Promise<{ ok: true; state: CompetitorsState } | { ok: false; error: string }> {
  if (!/^\d{5,20}$/.test(pageId)) return { ok: false, error: "page_id ไม่ถูกต้อง" };
  if (text.length < 20) return { ok: false, error: "ข้อความสั้นเกินไป — คัดลอกทั้งหน้า (Ctrl+A) จาก Ad Library" };
  if (text.length > 400_000) return { ok: false, error: "ข้อความยาวเกินไป (เกิน 400,000 ตัวอักษร)" };
  if (gc.__adsCompetitorsRun?.kind === "scan") return { ok: false, error: busyText() };
  const cfg = await load();
  const c = cfg.competitors.find((x) => x.pageId === pageId);
  if (!c) return { ok: false, error: "ไม่พบคู่แข่งเจ้านี้ในรายชื่อ" };
  const r = parsePasted(text, c.name);
  if (!r.ok && !r.none) return { ok: false, error: r.error };
  const s = await update((s) => {
    const prev = s.scans[pageId];
    const ads = r.ok ? r.ads : [];
    s.scans[pageId] = {
      pageId, name: c.name, status: ads.length ? "ok" : "none", source: "paste", at: now(),
      total: r.ok ? r.total : 0, ads, error: null, ...diff(prev, ads),
    };
  });
  return { ok: true, state: view(s) };
}

/* ---------------- เพิ่มคู่แข่ง: ชื่อเพจ / page_id / ลิงก์ ---------------- */

export async function resolvePage(query: string): Promise<{ ok: true; pages: PageCandidate[] } | { ok: false; error: string }> {
  const q = query.trim();
  if (q.length < 2 || q.length > 200) return { ok: false, error: "พิมพ์ชื่อเพจ, page_id หรือลิงก์ Ad Library" };
  if (gc.__adsCompetitorsRun?.kind === "scan") return { ok: false, error: busyText() };
  const id = q.match(/view_all_page_id=(\d{5,20})/)?.[1] ?? q.match(/^\d{5,20}$/)?.[0] ?? q.match(/facebook\.com\/(?:profile\.php\?id=)?(\d{5,20})/)?.[1];
  let browser;
  try {
    browser = await openBrowser();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    if (id) {
      const r = await pageAds(browser, id);
      if (!r.ok) return r;
      // เพจที่ไม่มีแอดรันอยู่ Ad Library ไม่บอกชื่อ → ให้ผู้ใช้ตั้งชื่อเอง (ใช้ page_id เป็นชื่อชั่วคราว)
      return { ok: true, pages: [{ pageId: id, name: r.ads[0]?.pageName ?? `เพจ ${id}`, ads: r.total ?? r.ads.length }] };
    }
    const r = await findPages(browser, q);
    if (!r.ok) return r;
    if (!r.pages.length) return { ok: false, error: `ไม่เจอเพจที่มีแอดรันอยู่จากคำว่า "${q}" — ลองใส่ page_id หรือลิงก์หน้า Ad Library ของเพจนั้นแทน` };
    return r;
  } finally {
    await browser.close().catch(() => {});
  }
}
