/** หน้า Daily Briefing (/briefing) — ชนิดข้อมูลที่ server ส่งให้หน้าเว็บ (ไม่มี token)
 *  ตัวเลข null = ไม่มีตัวเลขให้เทียบ (เช่น ไม่มีผลลัพธ์ → ต้นทุนต่อผลลัพธ์ไม่มี) · ห้ามแทนด้วยค่าเดา */

export interface BigNumber {
  key: "spend" | "results" | "cpr";
  label: string;
  unit: "baht" | "count";
  lowerIsBetter: boolean;
  now: number | null;
  prev: number | null;      // วันก่อนหน้า (เมื่อวานซืน)
  avg7: number | null;      // เฉลี่ย 7 วันก่อนเมื่อวาน
  note: string;             // คำอธิบายสั้น ๆ ใต้ตัวเลข
}

/** ตัวเลขโฆษณาแยกแพลตฟอร์ม (publisher_platform ของ Meta) — 8 วัน ตรงกับ days[] (ตัวสุดท้าย = เมื่อวาน)
 *  other = audience_network / messenger / threads / unknown รวมกัน · ส่งมาเฉพาะเมื่อมีค่าใช้จ่ายใน 8 วัน
 *  cpr null = วันนั้นไม่มีผลลัพธ์ (หารไม่ได้ — ไม่ใช่ ฿0) */
export type PlatformKey = "facebook" | "instagram" | "other";
export interface PlatformSeries {
  key: PlatformKey;
  label: string;
  spend: number[];
  results: number[];
  cpr: (number | null)[];
}

export interface Pick {
  name: string;
  detail: string;
  link: string;
}

/** ok:false = ดึงไม่ได้ (บอกเหตุผลใน error) */
export type Block<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface BestWorst { best: Pick | null; worst: Pick | null; note: string | null }

export interface PageStat { label: string; now: number | null; prev: number | null; avg7: number | null }

export interface Fix { text: string; from: string }

export interface BriefingSection {
  account: string;
  accountName: string;
  page: { name: string; link: string; picture: string | null } | null;
  ads: Block<{ big: BigNumber[]; mix: string; days: string[]; platforms: PlatformSeries[] }>;
  adPicks: Block<BestWorst>;
  posts: Block<BestWorst & { count: number }>;
  instagram: Block<BestWorst & { username: string; count: number }>;
  pageStats: Block<{ rows: PageStat[]; note: string }>;
  fixes: Fix[];
}

export interface BriefingData {
  ok: true;
  at: string;            // เวลาที่ดึง (ISO)
  yesterday: string;     // YYYY-MM-DD ตามเขตเวลาบัญชีโฆษณา
  sections: BriefingSection[];
  stale?: string;        // ดึงใหม่ไม่ได้ → แสดงชุดเดิมพร้อมเหตุผล
}

export type BriefingResult = BriefingData | { ok: false; error: string };

/** ตั้งเวลาอัปเดตอัตโนมัติวันละ 1 รอบ (เวลาไทย) — ตัวจับเวลาอยู่ในแอป ทำงานเมื่อแอปเปิดอยู่
 *  เลยเวลาแล้วแต่วันนี้ยังไม่ได้อัปเดต (เช่น เพิ่งเปิดแอป) → อัปเดตทันที · ล้มเหลว → ลองใหม่ทุก 15 นาทีจนสำเร็จ */
export interface BriefingSchedule {
  enabled: boolean;
  time: string;              // "HH:MM" 24 ชม. เวลาไทย
  lastAuto: string | null;   // อัปเดตอัตโนมัติสำเร็จครั้งล่าสุด (ISO)
  lastError: string | null;  // รอบอัตโนมัติล่าสุดล้มเหลวเพราะอะไร (null = ไม่มีปัญหา)
  next: string | null;       // รอบถัดไป (ISO) · null = ปิดอยู่
  running: boolean;          // กำลังอัปเดตอยู่ตอนนี้
}
