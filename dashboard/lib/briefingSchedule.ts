import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { getBriefing } from "./briefing";
import type { BriefingSchedule } from "./briefingTypes";

/** ตั้งเวลาอัปเดตหน้า Daily Briefing วันละ 1 รอบ (เวลาไทย)
 *  ตัวจับเวลาเริ่มตอนเซิร์ฟเวอร์แอปเปิด (instrumentation.ts) · เช็กทุก 30 วินาที
 *  เลยเวลาที่ตั้งแล้วแต่วันนี้ยังไม่ได้อัปเดต → อัปเดตทันที (รวมถึงเพิ่งเปิดแอปหลังเวลา) · ล้มเหลว → ลองใหม่ทุก 15 นาที */

const FILE = path.join(process.cwd(), "data", "briefing-schedule.json");
const TICK_MS = 30_000;
const RETRY_MS = 15 * 60_000;
const BKK_MS = 7 * 3600_000; // เวลาไทย UTC+7 (ไม่มีเวลาออมแสง)

interface Saved {
  enabled: boolean;
  time: string;
  lastAuto: string | null;
  lastAutoDay: string | null; // วันที่ (เวลาไทย) ที่อัปเดตอัตโนมัติสำเร็จแล้ว — วันละ 1 รอบ
  lastTry: string | null;
  lastError: string | null;
}
const DEFAULT: Saved = { enabled: true, time: "08:00", lastAuto: null, lastAutoDay: null, lastTry: null, lastError: null };

const gc = globalThis as unknown as { __adsBriefingTimer?: ReturnType<typeof setInterval>; __adsBriefingRunning?: boolean };

export const isTime = (t: unknown): t is string => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const bkkDay = (ms: number) => new Date(ms + BKK_MS).toISOString().slice(0, 10);
const atBkk = (day: string, time: string) => Date.parse(`${day}T${time}:00+07:00`);
const nextDay = (day: string) => bkkDay(Date.parse(`${day}T12:00:00+07:00`) + 86_400_000);

async function read(): Promise<Saved> {
  try {
    const s = { ...DEFAULT, ...(JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<Saved>) };
    return isTime(s.time) ? s : { ...s, time: DEFAULT.time };
  } catch {
    return { ...DEFAULT };
  }
}

let queue: Promise<unknown> = Promise.resolve();
/** แก้ไฟล์ทีละครั้ง (ตัวจับเวลากับผู้ใช้กดพร้อมกัน) · อ่านค่าล่าสุดก่อนแก้เสมอ ไม่ทับของกันและกัน */
function update(fn: (s: Saved) => Saved): Promise<Saved> {
  const next = queue.then(async () => {
    const s = fn(await read());
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE + ".tmp", JSON.stringify(s, null, 2), "utf8");
    await fs.rename(FILE + ".tmp", FILE);
    return s;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** รอบถัดไป (ms) · null = ปิดอยู่ */
function nextRun(s: Saved, now: number): number | null {
  if (!s.enabled) return null;
  const today = bkkDay(now);
  if (s.lastAutoDay === today) return atBkk(nextDay(today), s.time);
  const due = atBkk(today, s.time);
  if (now < due) return due;
  // เลยเวลาแล้วแต่วันนี้ยังไม่สำเร็จ → ทำเลย · ถ้าเพิ่งล้มเหลววันนี้ → รอรอบลองใหม่
  const tried = s.lastTry ? Date.parse(s.lastTry) : 0;
  return s.lastError && tried >= due ? Math.max(now, tried + RETRY_MS) : now;
}

function view(s: Saved, now = Date.now()): BriefingSchedule {
  const n = nextRun(s, now);
  return {
    enabled: s.enabled,
    time: s.time,
    lastAuto: s.lastAuto,
    lastError: s.lastError,
    next: n === null ? null : new Date(n).toISOString(),
    running: !!gc.__adsBriefingRunning,
  };
}

export async function getSchedule(): Promise<BriefingSchedule> {
  return view(await read());
}

export async function setSchedule(p: { enabled?: unknown; time?: unknown }): Promise<BriefingSchedule> {
  if (p.time !== undefined && !isTime(p.time)) throw new Error("เวลาไม่ถูกต้อง — ใช้รูปแบบ ชั่วโมง:นาที เช่น 08:00");
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") throw new Error("ค่าเปิด/ปิดไม่ถูกต้อง");
  const s = await update((cur) => ({
    ...cur,
    enabled: (p.enabled as boolean | undefined) ?? cur.enabled,
    time: (p.time as string | undefined) ?? cur.time,
  }));
  setTimeout(tick, 1_000); // ตั้งเวลาที่เลยไปแล้ว + วันนี้ยังไม่อัปเดต → ทำให้เลย ไม่ต้องรอ 30 วินาที
  return view(s);
}

/** ใช้ตอนเปิดหน้า: เปิดตั้งเวลาไว้ → แสดงชุดที่อัปเดตไว้ ไม่ต้องดึงใหม่ทุก 10 นาที */
export async function scheduleKeepsSnapshot(): Promise<boolean> {
  return (await read()).enabled;
}

async function tick() {
  if (gc.__adsBriefingRunning) return;
  const now = Date.now();
  const n = nextRun(await read(), now);
  if (n === null || n > now) return;
  gc.__adsBriefingRunning = true;
  try {
    const r = await getBriefing("auto");
    const at = new Date().toISOString();
    const why = !r.ok ? r.error : r.stale ?? null;
    await update((cur) => why
      ? { ...cur, lastTry: at, lastError: why }
      : { ...cur, lastTry: at, lastError: null, lastAuto: at, lastAutoDay: bkkDay(now) });
    console.log(`[briefing] อัปเดตอัตโนมัติ ${why ? "ไม่สำเร็จ: " + why : "สำเร็จ"}`);
  } catch (e) {
    const at = new Date().toISOString();
    await update((cur) => ({ ...cur, lastTry: at, lastError: (e as Error).message })).catch(() => undefined);
  } finally {
    gc.__adsBriefingRunning = false;
  }
}

/** เรียกครั้งเดียวตอนเซิร์ฟเวอร์เริ่ม — กันซ้อนด้วย globalThis (dev reload โมดูลได้หลายรอบ) */
export function startBriefingScheduler() {
  if (gc.__adsBriefingTimer) return;
  gc.__adsBriefingTimer = setInterval(() => void tick(), TICK_MS);
  setTimeout(() => void tick(), 5_000); // เพิ่งเปิดแอปหลังเวลาที่ตั้ง → ตามอัปเดตให้เลย
}
