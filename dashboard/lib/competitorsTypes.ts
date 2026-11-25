/** หน้าวิเคราะห์คู่แข่ง (/competitors) — ชนิดข้อมูลที่ server ส่งให้หน้าเว็บ
 *  ข้อมูลแอดมาจาก Meta Ad Library (ไทย · แอดที่รันอยู่) แบบไม่ล็อกอิน หรือข้อความที่ผู้ใช้วางเอง
 *  กฎ: เจ้าไหนไม่มีแอด/ดึงไม่ได้ → บอกตรง ๆ · Claude สรุปจากข้อความแอดจริงเท่านั้น ห้ามเดา */

const LIB = "https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=TH&is_targeted_country=false&media_type=all";
/** หน้า Ad Library ของเพจ (ใช้ทั้งตัวดึงและปุ่ม "เปิดใน Ad Library" — ลิงก์สาธารณะ ไม่มี token) */
export const adLibraryPageUrl = (pageId: string) => `${LIB}&search_type=page&view_all_page_id=${pageId}`;
export const adLibraryKeywordUrl = (q: string) => `${LIB}&q=${encodeURIComponent(`"${q}"`)}&search_type=keyword_exact_phrase`;
export const adLibrarySearchUrl = (q: string) => `${LIB}&q=${encodeURIComponent(q)}&search_type=keyword_unordered`;

/** แอด 1 ตัวใน Ad Library */
export interface CompetitorAd {
  id: string;                 // Library ID (ad_archive_id)
  pageId: string | null;      // null = มาจากข้อความที่วางเอง (ไม่มี page_id ในข้อความ)
  pageName: string;
  start: string | null;       // วันเริ่มรัน YYYY-MM-DD
  platforms: string[];        // FACEBOOK / INSTAGRAM / MESSENGER / AUDIENCE_NETWORK / THREADS
  body: string;               // ข้อความแอดเต็ม
  title: string | null;
  cta: string | null;         // ข้อความปุ่ม เช่น "Send message"
  link: string | null;        // ลิงก์ปลายทาง (ถ้ามี)
  format: string | null;      // IMAGE / VIDEO / DCO / CAROUSEL …
  copies: number;             // จำนวนแอดที่ใช้ชิ้นงานนี้ (collation_count) · วางเอง = 1
}

export interface Competitor { pageId: string; name: string }

/** ผลสแกนของคู่แข่ง 1 เจ้า
 *  ok = มีแอดรันอยู่ · none = Ad Library บอกว่าไม่มีแอดรันอยู่ในไทย · error = ดึงไม่ได้ (บอกเหตุผล + ให้วางเอง) */
export interface CompetitorScan {
  pageId: string;
  name: string;
  status: "ok" | "none" | "error";
  source: "auto" | "paste";
  at: string;                 // ISO
  total: number | null;       // จำนวนที่ Ad Library รายงาน (~N results) · null = ไม่รู้
  ads: CompetitorAd[];
  error: string | null;
  newIds: string[];           // แอดที่ไม่เคยเห็นในรอบก่อน (รอบแรก = ว่าง ไม่นับว่าใหม่)
  gone: number;               // แอดที่รอบก่อนมี รอบนี้หายไป
  longest?: Longest | null;   // แอปคำนวณตอนส่งให้หน้าเว็บ (ไม่เก็บในไฟล์)
}

/** ผู้ลงโฆษณาที่เจอจากคำค้น และยังไม่ได้อยู่ในรายชื่อคู่แข่ง */
export interface KeywordHit {
  pageId: string;
  name: string;
  ads: number;                // จำนวนแอดของเพจนี้ในผลค้นรอบนั้น
  keyword: string;
  sample: string;             // ข้อความต้น ๆ ของแอด 1 ตัว
}

export interface KeywordScan { keyword: string; at: string; total: number | null; error: string | null }

/** แถวในตารางสรุป — hook/offer จาก Claude · รันนานสุด แอปคำนวณจากวันเริ่มจริง */
export interface SummaryRow {
  pageId: string;
  name: string;
  hooks: string[];
  offer: string;
}
export interface Angle { title: string; why: string }
export interface CompetitorSummary {
  at: string;
  model: string;
  rows: SummaryRow[];
  angles: Angle[];
  note: string;               // ข้อสังเกตรวม 1–2 ประโยค
}

/** แอดที่รันนานสุดของแต่ละเจ้า (แอปคำนวณ ไม่ใช่ Claude) */
export interface Longest { id: string; start: string; days: number; text: string }

export interface CompetitorsState {
  business: string;
  competitors: Competitor[];
  keywords: string[];
  scans: Record<string, CompetitorScan>;   // key = pageId
  keywordScans: KeywordScan[];
  hits: KeywordHit[];
  lastScan: { at: string; error: string | null } | null;
  summary: CompetitorSummary | null;
  summaryError: string | null;
  /** กำลังทำงานอยู่ (สแกน / สรุป) — หน้าเว็บถามซ้ำทุก 3 วิ จนเป็น null */
  running: { kind: "scan" | "summary"; step: string; startedAt: string } | null;
}

/** ผลค้นชื่อเพจเพื่อเพิ่มคู่แข่ง */
export interface PageCandidate { pageId: string; name: string; ads: number }
