import "server-only";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

/** ตัวสร้างโฆษณาอยู่ที่ mcp-server/server.py — หน้าแอปเรียกผ่านบรรทัดคำสั่ง (กฎ PAUSED / เช็คสิทธิ์ อยู่ที่นั่นที่เดียว) */
export const AGENT_IDS = ["claude", "manus", "chatgpt"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const isAgentId = (v: unknown): v is AgentId => AGENT_IDS.includes(v as AgentId);

const SERVER_DIR = path.resolve(process.cwd(), "..", "mcp-server");
const SERVER_PY = path.join(SERVER_DIR, "server.py");

function pythonPath(): string {
  const win = path.join(SERVER_DIR, ".venv", "Scripts", "python.exe");
  const nix = path.join(SERVER_DIR, ".venv", "bin", "python");
  if (existsSync(win)) return win;
  if (existsSync(nix)) return nix;
  return process.platform === "win32" ? "python" : "python3";
}

export interface CheckItem { key: string; label: string; ok: boolean; detail: string }

/** ค่าจำกัดชิ้นงาน (ไดนามิก) — มาจาก server.py (หน้าเว็บแค่แสดง) */
export interface CreativeOptions {
  max_images: number;
  max_videos: number;
  max_bodies: number;
  max_titles: number;
  max_assets: number;
  max_video_mb: number;
  max_total_mb: number;
  dynamic_kinds: string[];
  dynamic_off_reason: string;
}

/** ตัวเลือกกลุ่มเป้าหมาย — มาจาก server.py (หน้าเว็บแค่แสดง) */
export interface AudienceOptions {
  min_age: number;
  max_age_min: number;
  default_age: number;
  min_age_max: number;      // อายุสูงสุดเลือกได้ตั้งแต่
  no_max_age: number;       // ค่านี้ = ไม่จำกัดอายุสูงสุด
  default_age_max: number;
  languages: { key: string; label: string }[];
  default_languages: string[];
  max_interests: number;
  brand_safety: { label: string; detail: string };
  ai: { provider: string; label: string; model: string; key_name: string; ready: boolean; missing: string | null };
  fixed: string;
}

/** ความสนใจจากคลังของ Meta (ปุ่ม ✨) */
export interface Interest {
  id: string;
  name: string;
  keyword?: string;
  size_lower?: number | null;   // ทั่วโลก
  size_upper?: number | null;
  th_lower?: number | null;     // คนในไทย อายุ 20+
  th_upper?: number | null;
}

/** คนในไทยที่สนใจอย่างน้อย 1 อย่างในชุด (mode "reach") · share = % ของผู้ใหญ่ในไทยบน Meta */
export interface ReachResult {
  success: boolean;
  error?: string;
  count?: number;
  lower?: number;
  upper?: number;
  share?: number | null;
  age_min?: number;
}

export interface SuggestResult {
  success: boolean;
  error?: string;
  ai?: string;
  model?: string;
  keywords?: string[];
  missed?: string[];
  skipped?: string[];    // ช่องพิมพ์คำค้นเอง: คำที่เกินเพดาน ไม่ได้ค้น
  brief?: boolean;       // ช่องพิมพ์คำค้น: เป็นประโยค → AI อ่านก่อนค้น
  interests?: Interest[];
  audience?: AudienceHint | null;   // อายุ/ภาษาที่ AI แนะนำ (ผู้ใช้กดใช้เอง)
}

/** อายุ/ภาษาที่ AI แนะนำ — ตัดให้อยู่ในช่วงที่ Meta รับแล้วที่ server.py */
export interface AudienceHint { age_min: number; age_max: number; languages: string[]; label: string; reason: string }

/** ความสนใจของ Ad Set ที่สร้างไปแล้ว (ปุ่ม "＋ เพิ่มความสนใจให้ Ad Set นี้") */
export interface AdsetInterestsResult {
  success: boolean;
  error?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  paused?: boolean;          // แก้ได้เฉพาะตอนแคมเปญและ Ad Set หยุดอยู่
  max_interests?: number;
  interests?: (Interest & { gone?: boolean })[];
  texts?: string[];          // ข้อความโฆษณาเดิม (ให้ ✨ คิด)
  titles?: string[];
  link_url?: string;
  before?: number;           // ตอนบันทึก: จำนวนเดิม
}

export interface AgentStatus {
  agent: AgentId;
  prefix: string;
  ready: boolean;
  configured?: boolean;
  quota_full?: boolean;
  reason: string;
  checks: CheckItem[];
  max_daily_budget_thb: number;
  max_campaigns_per_day: number;
  campaigns_today: number | null;
  page_name: string | null;
  page_cover: string | null;
  audience?: AudienceOptions;
  creative?: CreativeOptions;
  live?: LiveOptions;
}

/** ค่าของชนิด Live สด (server.py เป็นคนกำหนด) */
export interface LiveOptions {
  min_hours: number; max_hours: number; default_hours: number; thb_per_hour: number; lead_hours: number;
}

/** Live ที่นัดไว้ล่วงหน้าบนเพจ (กิจกรรมออนไลน์แบบ fb_live ที่ยังไม่เริ่ม) */
export interface LiveEvent { id: string; name: string; start_time: string }
export interface LivesResult { success: boolean; error?: string; lives: LiveEvent[]; page_name?: string | null }

/** สร้าง Live เสร็จ → สิ่งที่ผู้ใช้ต้องทำต่อใน Ads Manager (API ผูก Live นัดหมายไม่ได้) */
export interface LiveNext {
  live_name: string; start_time: string; text: string; adset_url: string; steps: string[]; lead_hours: number;
}

export interface CreateSpec {
  kind: "MESSENGER" | "WEBSITE" | "LIVE";
  live_id?: string;      // Live: กิจกรรม fb_live ที่นัดไว้ — server.py ตรวจว่าอยู่ในเพจและยังไม่เริ่ม
  live_hours?: number;   // Live: ความยาว (ชม.) — daily_budget_thb = งบรวมทั้ง Live
  name: string;
  daily_budget_thb: number;
  text: string;
  link_url?: string;
  image_url?: string;
  image_path?: string;
  start_time?: string;   // เวลาไทย "YYYY-MM-DDTHH:MM" — ว่าง = เริ่มทันทีเมื่อกดเปิด
  end_time?: string;     // ว่าง = ไม่มีวันสิ้นสุด
  age_min?: number;      // ว่าง = ค่าเริ่มต้นของ server.py
  age_max?: number;      // ว่าง = ค่าเริ่มต้นของ server.py · no_max_age = ไม่จำกัด
  interests?: { id: string; name: string }[];   // ค่าแนะนำ — จากปุ่ม ✨
  languages?: string[];  // รหัสภาษา เช่น ["th","en_us"] — ว่าง = ค่าเริ่มต้นของ server.py
  // ชิ้นงานแบบไดนามิก — ตรวจจำนวน/ขนาดที่ server.py
  dynamic?: boolean;
  texts?: string[];
  titles?: string[];
  image_paths?: string[];
  video_paths?: string[];
}

export interface CreateResult {
  success: boolean;
  agent: AgentId;
  steps: CheckItem[];
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  campaign_name?: string;
  dashboard_updated?: boolean;
  ads_manager_url?: string;
  live_next?: LiveNext;
}

/** รัน server.py แล้วอ่านผล JSON บรรทัดสุดท้าย */
export function runCreator<T>(agent: AgentId, args: string[], timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const p = spawn(pythonPath(), [SERVER_PY, "--agent", agent, ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("ตัวสร้างโฆษณาไม่ตอบภายในเวลาที่กำหนด")); }, timeoutMs);
    p.stdout.on("data", (b) => (out += b.toString("utf8")));
    p.stderr.on("data", (b) => (err += b.toString("utf8")));
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`เปิดตัวสร้างโฆษณาไม่ได้: ${e.message}`)); });
    p.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() ?? "";
      try {
        resolve(JSON.parse(line) as T);
      } catch {
        reject(new Error(`ตัวสร้างโฆษณาตอบกลับผิดรูปแบบ: ${(err || out).slice(-400)}`));
      }
    });
  });
}

/** หน้าสร้างโฆษณาใช้ได้เฉพาะจากเครื่องนี้ (กันคนในวง LAN ยิงเข้ามาสร้างโฆษณา) */
export function isLocalRequest(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}
