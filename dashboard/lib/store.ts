import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { Campaign, DailyRow, IngestPayload, PREFIXES, Prefix, Store, SyncInfo, prefixOf } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "store.json");

const empty = (): Store => ({ version: 1, campaigns: {}, rows: {}, syncs: {} });

let queue: Promise<unknown> = Promise.resolve();
/** เขียนทีละคำขอ — กัน 3 agent ส่งพร้อมกันแล้วไฟล์ทับกัน */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export async function readStore(): Promise<Store> {
  try {
    const s = JSON.parse(await fs.readFile(FILE, "utf8")) as Store;
    return { ...empty(), ...s };
  } catch {
    return empty();
  }
}

async function writeStore(s: Store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s), "utf8");
  await fs.rename(tmp, FILE);
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface UpsertResult {
  campaigns: number;
  rows: number;
  skipped: number;
  removed: number;
  prefixes: Prefix[];
}

/** รวมข้อมูลเข้า store — prefix คำนวณจากชื่อแคมเปญเสมอ (ไม่เชื่อค่าที่ส่งมา) */
export function upsert(payload: IngestPayload, source: SyncInfo["source"]): Promise<UpsertResult> {
  return serial(async () => {
    const s = await readStore();
    const touched = new Set<Prefix>();
    const counts: Partial<Record<Prefix, { c: number; r: number }>> = {};
    const bump = (p: Prefix, k: "c" | "r") => {
      counts[p] ??= { c: 0, r: 0 };
      counts[p]![k]++;
    };
    let skipped = 0;

    // รายชื่อแคมเปญที่ส่งมา = รายชื่อล่าสุดจาก Meta (Meta ไม่ส่งแคมเปญที่เก็บถาวร/ลบแล้วมา)
    // → แคมเปญของ prefix เดียวกันที่ไม่อยู่ในรายชื่อนี้ ให้ลบออกพร้อมตัวเลขรายวัน
    const removed = Array.isArray(payload.campaigns) ? prune(s, payload, source) : 0;

    for (const c of payload.campaigns ?? []) {
      const p = prefixOf(c.name);
      if (!p || !c.id) { skipped++; continue; }
      const camp: Campaign = {
        id: String(c.id),
        name: c.name,
        prefix: p,
        status: String(c.status ?? "PAUSED"),
        objective: c.objective ?? null,
        created_time: c.created_time ?? null,
      };
      s.campaigns[camp.id] = camp;
      touched.add(p);
      bump(p, "c");
    }

    for (const r of payload.rows ?? []) {
      const p = prefixOf(r.campaign_name);
      if (!p || !r.campaign_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "")) { skipped++; continue; }
      const row: DailyRow = {
        date: r.date,
        campaign_id: String(r.campaign_id),
        campaign_name: r.campaign_name,
        prefix: p,
        spend: num(r.spend),
        impressions: num(r.impressions),
        reach: num(r.reach),
        clicks: num(r.clicks),
        link_clicks: num(r.link_clicks),
        results: num(r.results),
      };
      s.rows[`${row.campaign_id}|${row.date}`] = row;
      s.campaigns[row.campaign_id] ??= {
        id: row.campaign_id, name: row.campaign_name, prefix: p, status: "UNKNOWN", objective: null, created_time: null,
      };
      touched.add(p);
      bump(p, "r");
    }

    const at = new Date().toISOString();
    for (const p of touched) {
      s.syncs[p] = {
        at, source, date_preset: payload.date_preset ?? "-",
        campaigns: counts[p]?.c ?? 0, rows: counts[p]?.r ?? 0,
      };
    }
    await writeStore(s);
    return {
      campaigns: Object.values(counts).reduce((a, x) => a + (x?.c ?? 0), 0),
      rows: Object.values(counts).reduce((a, x) => a + (x?.r ?? 0), 0),
      skipped,
      removed,
      prefixes: [...touched],
    };
  });
}

/** prefix ที่ข้อมูลชุดนี้ครอบคลุม: ส่งจาก agent = prefix ของ agent นั้น · ดึงจาก Meta ตรง = ทุก prefix */
function coveredPrefixes(payload: IngestPayload, source: SyncInfo["source"]): Prefix[] {
  const p = payload.prefix ? prefixOf(payload.prefix) : null;
  if (p) return [p];
  return source === "meta" ? [...PREFIXES] : [];
}

/** ลบแคมเปญ (และตัวเลขรายวัน) ที่หายไปจาก Meta แล้ว — คืนจำนวนแคมเปญที่ลบ */
function prune(s: Store, payload: IngestPayload, source: SyncInfo["source"]): number {
  const covered = new Set(coveredPrefixes(payload, source));
  if (covered.size === 0) return 0;
  const keep = new Set((payload.campaigns ?? []).map((c) => String(c.id)));
  let n = 0;
  for (const [id, c] of Object.entries(s.campaigns)) {
    if (covered.has(c.prefix) && !keep.has(id)) {
      delete s.campaigns[id];
      n++;
    }
  }
  if (n > 0) {
    for (const [k, r] of Object.entries(s.rows)) {
      if (!s.campaigns[r.campaign_id]) delete s.rows[k];
    }
  }
  return n;
}

export function clearStore(): Promise<void> {
  return serial(() => writeStore(empty()));
}
