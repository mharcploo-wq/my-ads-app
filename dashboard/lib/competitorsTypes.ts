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

/** ปุ่ม ✨ คิดความสนใจ + คำโฆษณา 5 ชุด — ความสนใจค้นจากคลังจริงของ Meta (id ใช้ตั้งกลุ่มเป้าหมายได้) */
export interface CopyInterest {
  id: string; name: string; keyword?: string;
  size_lower?: number | null; size_upper?: number | null;   // ทั่วโลก
  th_lower?: number | null; th_upper?: number | null;       // คนไทยอายุ 20+
}
/** คำโฆษณา 1 ชุด · new = มุมที่ยังไม่มีใครเล่น · fix = แก้จุดอ่อนของแอดคู่แข่ง */
export interface CopySet {
  kind: "new" | "fix";
  angle: string;
  primary: string;            // ข้อความหลัก
  headline: string;           // พาดหัว
  description: string;        // คำอธิบายสั้น
  cta: string;                // MESSAGE_PAGE / LEARN_MORE / …
  ctaLabel: string;           // ชื่อปุ่มภาษาไทย
  why: string;
  image?: CopyImage | null;   // ปุ่ม 🎨 — prompt ภาพของชุดนี้ (ไม่มี = ยังไม่กด)
  video?: CopyVideo | null;   // ปุ่ม 🎬 — prompt คลิป 16 วิ (กด 🎨 ใหม่ = ล้าง เพราะช็อต 1 ใช้ภาพ 9:16 รอบนั้น)
}
/** คลิปโฆษณา 16 วิ = 2 ช็อต × 8 วิ (Veo 3.1 / Omni 1.2 ใน Google Flow) ไปต่อกันใน CapCut · แอปไม่สร้างคลิปเอง */
export interface CopyVideo {
  story: string;              // เรื่องย่อทั้งคลิป (ไทย)
  shots: VideoShot[];
  avoid: string;              // สิ่งที่ห้ามมีในคลิป (อังกฤษ) — ต่อท้าย prompt ตอนคัดลอก
}
export interface VideoShot {
  goal: string;               // "ปัญหา" / "ทางออก + ชวนทักแชต"
  frame: string | null;       // prompt ภาพเฟรมแรก · null = ใช้ภาพ 9:16 จากปุ่ม 🎨 (ช็อต 1)
  line: string;               // บทพูดไทย (ควร ≤ VIDEO_LINE_MAX ตัวอักษร)
  prompt: string;             // prompt คลิป (อังกฤษ มีบทพูดในเครื่องหมายคำพูด)
  caption: string;            // ข้อความขึ้นจอแนะนำ ใส่เองใน CapCut
}
/** ตัวอักษรไทยที่พูดทันใน 8 วิ — เกินแล้วหน้าเว็บขึ้นสีแดง (ไม่ตัดให้เอง) */
export const VIDEO_LINE_MAX = 80;
/** prompt ภาพประกอบ 1 ชุด (ภาษาอังกฤษ · ใช้กับ ChatGPT / Gemini / Midjourney) · แอปไม่สร้างภาพเอง */
export interface CopyImage {
  scene: string;              // ฉาก (ไทย)
  square: string;             // prompt 1:1 Feed
  story: string;              // prompt 9:16 Story / Reels
  avoid: string;              // สิ่งที่ห้ามมีในภาพ (อังกฤษ คั่นด้วย ,) — ต่อท้าย prompt ตอนคัดลอก
  spaceSquare: string;        // วางพาดหัวตรงไหน (1:1)
  spaceStory: string;         // วางพาดหัวตรงไหน (9:16)
}
export interface CompetitorCopy {
  at: string;
  model: string;
  adsUsed: number;            // จำนวนแอดคู่แข่งที่ส่งให้ Claude
  why: string;                // ทำไมเลือกความสนใจกลุ่มนี้
  interests: CopyInterest[];
  missed: string[];           // คำที่ Claude คิดแต่ไม่เจอในคลังของ Meta
  reach: { lower: number; upper: number } | null;   // คนไทยที่สนใจอย่างน้อย 1 อย่าง
  searchError: string | null; // ค้นคลัง Meta ไม่ได้ (ยังได้คำโฆษณา)
  sets: CopySet[];
  // ปุ่ม 🎨 — กด ✨ คิดคำโฆษณาใหม่ = ทั้งก้อนถูกแทนที่ prompt ภาพเดิมหายไปด้วย (ไม่ปนกับคำโฆษณาชุดใหม่)
  imagesAt?: string | null;
  imagesModel?: string | null;
  imagesError?: string | null;
  videosAt?: string | null;
  videosModel?: string | null;
  videosError?: string | null;
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
  copy: CompetitorCopy | null;
  copyError: string | null;
  /** กำลังทำงานอยู่ (สแกน / สรุป / คิดคำโฆษณา / คิด prompt ภาพ) — หน้าเว็บถามซ้ำทุก 3 วิ จนเป็น null */
  running: { kind: "scan" | "summary" | "copy" | "image" | "video"; step: string; startedAt: string } | null;
}

/** ผลค้นชื่อเพจเพื่อเพิ่มคู่แข่ง */
export interface PageCandidate { pageId: string; name: string; ads: number }

/** การ์ด "Claude สำหรับวิเคราะห์คู่แข่ง" (แท็บเชื่อมต่อ API) — คีย์เก็บใน mcp-server/.env.competitors
 *  ไม่ส่งคีย์เต็มออกมา · ช่องคีย์ว่าง = ใช้คีย์ของ Agent Claude แทน */
export const COMPETITOR_MODELS = [
  { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5 · สมดุล วิเคราะห์ละเอียด (ค่าเริ่มต้น)" },
  { id: "claude-haiku-5-5", label: "claude-haiku-5-5 · ถูก เร็ว สรุปตื้นกว่า" },
  { id: "claude-opus-5-5", label: "claude-opus-5-5 · ละเอียดสุด แพงสุด" },
] as const;
export type CompetitorModel = (typeof COMPETITOR_MODELS)[number]["id"];

export interface KeyInfo { set: boolean; last4: string | null }
export interface CompetitorsClaudeView {
  own: KeyInfo & { userKey: boolean };   // คีย์ของฟังก์ชันนี้
  agent: KeyInfo;                         // คีย์ของ Agent Claude (ใช้แทนเมื่อ own ว่าง)
  using: "own" | "agent" | "none";
  last4: string | null;                   // คีย์ที่ใช้อยู่จริง
  workspace: string;                      // wrkspc_… (ไม่ใช่ความลับ)
  model: CompetitorModel;
  check: CompetitorsClaudeCheck | null;   // ผลทดสอบล่าสุด (จำในหน่วยความจำ server)
}
export interface CompetitorsClaudeInput { aiKey?: string; workspace: string; model: string; clear?: boolean }
export interface CompetitorsClaudeCheck { ok: boolean; text: string; at: string; using: string; last4: string | null; model: string }
