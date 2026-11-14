/** รูปข้อมูลหน้า "วิเคราะห์โฆษณา" — ใช้ร่วมกันระหว่าง server (lib/insights.ts) กับหน้าเว็บ
 *  ตัวเลขทุกตัวคิดที่ server แล้ว · หน้าเว็บแค่แสดงผล */
import type { Prefix } from "./types";

export const RANGES = [
  { key: "today", label: "วันนี้" },
  { key: "yesterday", label: "เมื่อวาน" },
  { key: "last_7d", label: "7 วัน" },
  { key: "last_14d", label: "14 วัน" },
  { key: "last_30d", label: "30 วัน" },
  { key: "this_month", label: "เดือนนี้" },
  { key: "last_month", label: "เดือนที่แล้ว" },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];
export const DEFAULT_RANGE: RangeKey = "last_30d";

/** กรองแคมเปญ: ทั้งหมด · ที่ agent สร้าง (มี prefix) · ราย agent · ที่คนสร้าง (ไม่มี prefix) */
export const WHOS = ["all", "agent", "CLD-", "MANUS-", "GPT-", "human"] as const;
export type WhoKey = (typeof WHOS)[number];

export type Sev = "critical" | "serious" | "warning" | "info";
/** ป้ายระดับคำแนะนำ — สีสถานะใช้คู่ไอคอน+คำเสมอ (ไม่ใช้สีอย่างเดียว) */
export const SEV: Record<Sev, { icon: string; label: string }> = {
  critical: { icon: "⛔", label: "ควรแก้ด่วน" },
  serious: { icon: "▲", label: "แพงผิดปกติ" },
  warning: { icon: "⚠", label: "ควรดู" },
  info: { icon: "ℹ", label: "ข้อสังเกต" },
};
export type Level = "campaign" | "adset" | "ad";

export interface Metrics {
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  link_clicks: number;
  link_ctr: number;         // %
  link_cpc: number | null;  // บาท/คลิกลิงก์
  cpm: number | null;       // บาท/1,000 การแสดงผล
}

/** ผลลัพธ์ตามเป้าหมายของแคมเปญ (ฟิลด์ results ของ Meta — ตัวเดียวกับคอลัมน์ "ผลลัพธ์" ใน Ads Manager) */
export interface Result {
  indicator: string;
  label: string;   // การเข้าชมแลนดิ้งเพจ
  unit: string;    // ครั้ง
  short: string;   // ป้ายสั้นในตาราง
  value: number;
  cost: number | null;   // ต้นทุนต่อผลลัพธ์ (การเข้าถึง = ต่อ 1,000 คน)
  per: number;           // 1 หรือ 1000
}

/** อันดับที่ Meta ให้ (ระดับโฆษณา) — text = คำอธิบายภาษาไทย */
export interface Rank { level: "above" | "average" | "below" | null; text: string }

export interface Node {
  id: string;
  name: string;
  level: Level;
  status: string;      // effective_status ของ Meta
  active: boolean;     // กำลังเปิดจริง (นับรวมแคมเปญ/ชุดแม่)
  agent: Prefix | null;
  m: Metrics;
  result: Result | null;
  ranking?: { quality: Rank; engagement: Rank; conversion: Rank };
  flag: Sev | null;    // มีคำแนะนำที่ชี้มาที่แถวนี้
  link: string;        // เปิดใน Ads Manager
  children: Node[];
}

export interface Rec {
  id: string;
  sev: Sev;
  title: string;
  evidence: string;
  suggest: string;
  paused: boolean;     // ของที่ปิดไปแล้ว (ลดจากป้ายแดง/ส้มเป็น "ควรดู")
  link: string | null;
}

export interface ResultTotal { indicator: string; label: string; unit: string; value: number; spend: number; cost: number | null; per: number; campaigns: number }
export interface DailyPoint { date: string; spend: number; impressions: number; link_clicks: number; results: number }
export interface AgeCell { age: string; gender: "female" | "male" | "unknown"; spend: number; link_clicks: number }
export interface PlacementRow { key: string; label: string; spend: number; link_clicks: number; share: number; cpc: number | null; hot: boolean }

export interface InsightsData {
  ok: true;
  account: { id: string; name: string; currency: string };
  range: RangeKey;
  who: WhoKey;
  period: { since: string; until: string; days: number } | null;   // null = ช่วงนี้ไม่มีการแสดงผล
  prevPeriod: { since: string; until: string } | null;
  fetched_at: string;
  stale: string | null;    // ดึงใหม่ไม่ได้ → แสดงชุดเดิม + เหตุผล
  total: Metrics;
  prev: Metrics | null;
  results: ResultTotal[];
  daily: DailyPoint[];
  campaigns: Node[];
  idle: { id: string; name: string; agent: Prefix | null }[];   // แคมเปญที่ตรงตัวกรองแต่ไม่มีค่าใช้จ่ายในช่วงนี้
  counts: { campaigns: number; active: number };
  age: AgeCell[];
  placements: PlacementRow[];
  recs: Rec[];
  rules: { key: string; text: string }[];
}

export type InsightsResponse = InsightsData | { ok: false; error: string };

/** ผลสรุปจาก Claude (ปุ่ม ✨) */
export interface AiSummary {
  success: boolean;
  error?: string | null;
  model?: string;
  headline?: string;
  points?: { title: string; detail: string }[];
  try_first?: string;
}
