import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { runCreator } from "./creator";
import {
  COMPETITOR_MODELS, CompetitorModel, CompetitorsClaudeCheck, CompetitorsClaudeInput, CompetitorsClaudeView, KeyInfo,
} from "./competitorsTypes";

/** คีย์ Claude ของหน้าวิเคราะห์คู่แข่ง — เก็บใน mcp-server/.env.competitors (อยู่ใน .gitignore)
 *  server.py อ่านไฟล์เดียวกันตอนสรุป/ทดสอบ (competitors_claude) · ช่องคีย์ว่าง = ใช้คีย์ของ Agent Claude
 *  คีย์ไม่ถูกส่งกลับไปที่เบราว์เซอร์ — ส่งแค่ 4 ตัวท้าย */

const SERVER_DIR = path.resolve(process.cwd(), "..", "mcp-server");
const FILE = path.join(SERVER_DIR, ".env.competitors");
const AGENT_FILE = path.join(SERVER_DIR, ".env.claude");
const KEY_PATTERN = /^sk-ant-[\x21-\x7e]{20,}$/;
const WORKSPACE_PATTERN = /^wrkspc_[A-Za-z0-9]{8,64}$/;
const USER_KEY_PREFIX = "sk-ant-usr-";
const MODEL_IDS = COMPETITOR_MODELS.map((m) => m.id) as readonly string[];
const DEFAULT_MODEL: CompetitorModel = "claude-sonnet-5-5";

const gc = globalThis as unknown as { __adsCompetitorsClaudeCheck?: CompetitorsClaudeCheck | null };

function parse(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const hit = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (hit) m.set(hit[1], hit[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
  return m;
}
const readEnv = async (f: string) => parse(await fs.readFile(f, "utf8").catch(() => ""));
const info = (v: string | undefined): KeyInfo => {
  const s = (v ?? "").trim();
  return KEY_PATTERN.test(s) ? { set: true, last4: s.slice(-4) } : { set: false, last4: null };
};

export async function getCompetitorsClaude(): Promise<CompetitorsClaudeView> {
  const [m, a] = await Promise.all([readEnv(FILE), readEnv(AGENT_FILE)]);
  const own = info(m.get("ANTHROPIC_API_KEY"));
  // server.py นับคีย์ agent ที่ไม่ว่าง (ไม่ตรวจรูปแบบ) — หน้าเว็บนับแบบเดียวกันเพื่อบอก "ตอนนี้ใช้" ให้ตรงกัน
  const agentRaw = (a.get("ANTHROPIC_API_KEY") ?? "").trim();
  const agent: KeyInfo = agentRaw ? { set: true, last4: agentRaw.slice(-4) } : { set: false, last4: null };
  const model = (m.get("AI_MODEL") ?? "").trim();
  const using = own.set ? "own" : agent.set ? "agent" : "none";
  return {
    own: { ...own, userKey: (m.get("ANTHROPIC_API_KEY") ?? "").trim().startsWith(USER_KEY_PREFIX) },
    agent,
    using,
    last4: using === "own" ? own.last4 : using === "agent" ? agent.last4 : null,
    workspace: (m.get("ANTHROPIC_WORKSPACE_ID") ?? "").trim(),
    model: (MODEL_IDS.includes(model) ? model : DEFAULT_MODEL) as CompetitorModel,
    check: gc.__adsCompetitorsClaudeCheck ?? null,
  };
}

/** ตรวจค่าที่ส่งมา → ข้อความผิดต่อช่อง (ภาษาไทย) */
function validate(input: CompetitorsClaudeInput, currentKey: string): Record<string, string> {
  const e: Record<string, string> = {};
  const key = (input.aiKey ?? "").trim();
  if (key && !KEY_PATTERN.test(key)) e.aiKey = "คีย์ Claude ต้องขึ้นต้นด้วย sk-ant- และไม่มีช่องว่าง";
  const ws = (input.workspace ?? "").trim();
  if (ws && !WORKSPACE_PATTERN.test(ws)) e.workspace = "ต้องขึ้นต้นด้วย wrkspc_ ตามด้วยตัวอักษร/ตัวเลข หรือเว้นว่าง";
  const finalKey = input.clear ? "" : key || currentKey;
  if (finalKey.startsWith(USER_KEY_PREFIX) && !ws) e.workspace = "คีย์ที่ขึ้นต้นด้วย sk-ant-usr- ต้องใส่ Workspace ID ด้วย";
  if (!MODEL_IDS.includes(input.model)) e.model = "เลือกรุ่นจากรายการ";
  return e;
}

/** บันทึกลงไฟล์ · clear = ลบคีย์ของฟังก์ชันนี้ (กลับไปใช้คีย์ Agent Claude) แต่คงรุ่นที่เลือกไว้ */
export async function saveCompetitorsClaude(input: CompetitorsClaudeInput): Promise<{ ok: boolean; errors: Record<string, string> }> {
  const m = await readEnv(FILE);
  const current = (m.get("ANTHROPIC_API_KEY") ?? "").trim();
  const errors = validate(input, current);
  if (Object.keys(errors).length) return { ok: false, errors };
  const key = input.clear ? "" : (input.aiKey ?? "").trim() || current;
  const ws = input.clear ? "" : (input.workspace ?? "").trim();
  const text = [
    "# Claude ของหน้าวิเคราะห์คู่แข่ง (/competitors) — แก้จากแท็บ \"เชื่อมต่อ API\" · ห้าม commit / ห้ามส่งให้ใคร",
    "# ANTHROPIC_API_KEY ว่าง = ใช้คีย์ของ Agent Claude (.env.claude)",
    `ANTHROPIC_API_KEY=${key}`,
    `ANTHROPIC_WORKSPACE_ID=${ws}`,
    `AI_MODEL=${input.model}`,
    "",
  ].join("\n");
  await fs.writeFile(FILE, text, "utf8");
  gc.__adsCompetitorsClaudeCheck = null;   // คีย์/รุ่นเปลี่ยน → ผลทดสอบเดิมไม่จริงแล้ว
  return { ok: true, errors: {} };
}

/** ปุ่ม 🔌 ทดสอบการเชื่อมต่อ — server.py ถามข้อมูลรุ่นจาก Anthropic (ไม่เสียค่าโทเคน) */
export async function checkCompetitorsClaude(): Promise<CompetitorsClaudeCheck> {
  let r: Omit<CompetitorsClaudeCheck, "at">;
  try {
    r = await runCreator<Omit<CompetitorsClaudeCheck, "at">>("claude", ["--competitors-claude-check"], 45_000);
  } catch (e) {
    r = { ok: false, text: (e as Error).message, using: "none", last4: null, model: "" };
  }
  const out = { ...r, at: new Date().toISOString() };
  gc.__adsCompetitorsClaudeCheck = out;
  return out;
}
