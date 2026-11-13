import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { AgentId, MAX_PORTFOLIO } from "@/lib/creator";

/** อ่าน/เขียนไฟล์ mcp-server/.env.{agent} จากหน้า "ตั้งค่า Agent" — โทเคนไม่ถูกส่งกลับไปที่เบราว์เซอร์ */

const SERVER_DIR = path.resolve(process.cwd(), "..", "mcp-server");
const PREFIX: Record<AgentId, string> = { claude: "CLD-", manus: "MANUS-", chatgpt: "GPT-" };

/** คีย์ AI ของปุ่ม ✨ ให้ AI คิดกลุ่มเป้าหมาย — claude/manus ใช้ Claude · chatgpt ใช้ OpenAI (ตรงกับ server.py AI_PROVIDER) */
export const AI_KEY: Record<AgentId, { name: string; label: string; workspace: boolean }> = {
  claude: { name: "ANTHROPIC_API_KEY", label: "Claude", workspace: true },
  manus: { name: "ANTHROPIC_API_KEY", label: "Claude", workspace: true },
  chatgpt: { name: "OPENAI_API_KEY", label: "OpenAI", workspace: false },
};
const AI_KEY_PATTERN = /^sk-[\x21-\x7e]{20,}$/;
/** คีย์ Claude ระดับผู้ใช้ไม่ผูก workspace → ต้องมี ANTHROPIC_WORKSPACE_ID (server.py ส่งเป็น header ให้) */
const USER_KEY_PREFIX = "sk-ant-usr-";

/** เพดานที่ตกลงกันไว้ — server.py บังคับซ้ำอีกชั้น */
export const LIMITS = { maxBudgetThb: 1000, maxCampaignsPerDay: 5 } as const;

/** ช่องที่แก้ได้จากหน้าเว็บ (ไม่รวมโทเคน/secret ซึ่งแยกไว้) */
export const EDITABLE_KEYS = [
  "META_AD_ACCOUNT_ID",
  "META_PAGE_ID",
  "META_PIXEL_ID",
  "META_VERIFIED_IDENTITY_ID",
  "MAX_DAILY_BUDGET_THB",
  "MAX_CAMPAIGNS_PER_DAY",
  "GRAPH_API_VERSION",
  "DASHBOARD_API_URL",
  "AI_MODEL",
  "ANTHROPIC_WORKSPACE_ID",
] as const;
export type EditableKey = (typeof EDITABLE_KEYS)[number];
export type EnvValues = Record<EditableKey, string>;

export interface SecretInfo { set: boolean; last4: string | null }

/** พอร์ตโฟลิโอเพิ่มเติม (พอร์ต 2–5) — เก็บเป็น META_PORTFOLIO_{n}_* ในไฟล์เดียวกัน · token แยกต่อพอร์ต */
export const PORTFOLIO_KEYS = ["AD_ACCOUNT_ID", "PAGE_ID", "PIXEL_ID", "VERIFIED_IDENTITY_ID"] as const;
export type PortfolioKey = (typeof PORTFOLIO_KEYS)[number];
export const EXTRA_SLOTS = Array.from({ length: MAX_PORTFOLIO - 1 }, (_, i) => i + 2);   // [2, 3, 4, 5]
const pfKey = (slot: number, k: PortfolioKey | "TOKEN") => `META_PORTFOLIO_${slot}_${k}`;
const TOKEN_PATTERN = /^EAA[A-Za-z0-9]{20,}$/;

export interface PortfolioView { slot: number; token: SecretInfo; values: Record<PortfolioKey, string> }
export interface PortfolioInput { slot: number; token?: string; values: Record<PortfolioKey, string>; remove?: boolean }

export interface AgentEnvView {
  agent: AgentId;
  prefix: string;
  file: string;          // เช่น mcp-server/.env.manus
  exists: boolean;
  values: EnvValues;
  token: SecretInfo;     // META_ACCESS_TOKEN
  secret: SecretInfo;    // DASHBOARD_API_SECRET
  aiKey: SecretInfo & { name: string; label: string; workspace: boolean; userKey: boolean };   // ANTHROPIC_API_KEY / OPENAI_API_KEY
  portfolios: PortfolioView[];   // พอร์ตเพิ่มเติมที่ตั้งไว้ (เรียงตามเลขพอร์ต)
}

export interface AgentEnvInput {
  values: EnvValues;
  token?: string;        // ว่าง = ใช้ค่าเดิม
  secret?: string;       // ว่าง = ใช้ค่าเดิม
  aiKey?: string;        // ว่าง = ใช้ค่าเดิม
  portfolios?: PortfolioInput[];   // ไม่ส่งมา = ไม่แตะพอร์ตเพิ่มเติม
}

const envPath = (a: AgentId) => path.join(SERVER_DIR, `.env.${a}`);

function parse(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const hit = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (hit) m.set(hit[1], hit[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
  return m;
}

/** ค่าที่เป็นข้อความตัวอย่าง (เช่น "ใส่โทเคน…") นับว่ายังไม่ได้ใส่ */
function secretInfo(v: string | undefined, pattern: RegExp): SecretInfo {
  const s = (v ?? "").trim();
  return pattern.test(s) ? { set: true, last4: s.slice(-4) } : { set: false, last4: null };
}

async function readText(a: AgentId): Promise<{ text: string; exists: boolean }> {
  try {
    return { text: await fs.readFile(envPath(a), "utf8"), exists: true };
  } catch {
    const example = await fs.readFile(path.join(SERVER_DIR, ".env.example"), "utf8").catch(() => "");
    return { text: example, exists: false };
  }
}

export async function readAgentEnv(a: AgentId): Promise<AgentEnvView> {
  const { text, exists } = await readText(a);
  const m = parse(text);
  const values = Object.fromEntries(EDITABLE_KEYS.map((k) => [k, m.get(k) ?? ""])) as EnvValues;
  if (!values.GRAPH_API_VERSION) values.GRAPH_API_VERSION = "v21.0";
  return {
    agent: a,
    prefix: PREFIX[a],
    file: `mcp-server/.env.${a}`,
    exists,
    values,
    token: secretInfo(m.get("META_ACCESS_TOKEN"), /^EAA[A-Za-z0-9]{20,}$/),
    secret: secretInfo(m.get("DASHBOARD_API_SECRET"), /^[\x21-\x7e]{8,}$/),
    aiKey: {
      ...secretInfo(m.get(AI_KEY[a].name), AI_KEY_PATTERN), ...AI_KEY[a],
      userKey: AI_KEY[a].workspace && (m.get(AI_KEY[a].name) ?? "").trim().startsWith(USER_KEY_PREFIX),
    },
    portfolios: EXTRA_SLOTS
      .filter((n) => (["TOKEN", ...PORTFOLIO_KEYS] as const).some((k) => (m.get(pfKey(n, k)) ?? "").trim()))
      .map((n) => ({
        slot: n,
        token: secretInfo(m.get(pfKey(n, "TOKEN")), TOKEN_PATTERN),
        values: Object.fromEntries(PORTFOLIO_KEYS.map((k) => [k, m.get(pfKey(n, k)) ?? ""])) as Record<PortfolioKey, string>,
      })),
  };
}

/** ตรวจพอร์ตเพิ่มเติม — คีย์ error: pf{slot}.{TOKEN|AD_ACCOUNT_ID|…} · saved = พอร์ตที่มี token ในไฟล์แล้ว */
export function validatePortfolios(list: PortfolioInput[], saved: Set<number>): Record<string, string> {
  const e: Record<string, string> = {};
  const seen = new Set<number>();
  for (const p of list) {
    if (!EXTRA_SLOTS.includes(p.slot) || seen.has(p.slot)) { e[`pf${p.slot}`] = "เลขพอร์ตไม่ถูกต้อง"; continue; }
    seen.add(p.slot);
    if (p.remove) continue;
    const k = (f: string) => `pf${p.slot}.${f}`;
    if (p.token && !TOKEN_PATTERN.test(p.token)) e[k("TOKEN")] = "รหัสต้องขึ้นต้นด้วย EAA และไม่มีช่องว่าง";
    if (!p.token && !saved.has(p.slot)) e[k("TOKEN")] = "ใส่ token ของ system user ในพอร์ตนี้";
    const v = p.values;
    for (const f of PORTFOLIO_KEYS) {
      if (typeof v?.[f] !== "string") { e[k(f)] = "ไม่มีค่า"; continue; }
      if (/[\r\n]/.test(v[f])) e[k(f)] = "ห้ามขึ้นบรรทัดใหม่";
    }
    if (!v) continue;
    if (v.AD_ACCOUNT_ID && !/^act_\d{5,}$/.test(v.AD_ACCOUNT_ID)) e[k("AD_ACCOUNT_ID")] = "ต้องเป็น act_ ตามด้วยตัวเลข หรือเว้นว่าง";
    for (const f of ["PAGE_ID", "PIXEL_ID", "VERIFIED_IDENTITY_ID"] as const)
      if (v[f] && !/^\d{5,}$/.test(v[f])) e[k(f)] = "ตัวเลขล้วน หรือเว้นว่าง";
  }
  return e;
}

/** ตรวจค่าก่อนบันทึก — คืนรายการข้อผิดพลาดแยกตามช่อง (ว่าง = ผ่าน) */
export function validate(input: AgentEnvInput): Partial<Record<EditableKey | "token" | "secret" | "aiKey", string>> {
  const v = input.values;
  const e: Partial<Record<EditableKey | "token" | "secret" | "aiKey", string>> = {};
  for (const k of EDITABLE_KEYS) {
    if (typeof v[k] !== "string") { e[k] = "ไม่มีค่า"; continue; }
    if (/[\r\n]/.test(v[k])) e[k] = "ห้ามขึ้นบรรทัดใหม่";
  }
  if (!/^act_\d{5,}$/.test(v.META_AD_ACCOUNT_ID ?? "")) e.META_AD_ACCOUNT_ID = "ต้องเป็น act_ ตามด้วยตัวเลข";
  if (!/^\d{5,}$/.test(v.META_PAGE_ID ?? "")) e.META_PAGE_ID = "ใส่เลขเพจ (ตัวเลขล้วน)";
  if (v.META_PIXEL_ID && !/^\d{5,}$/.test(v.META_PIXEL_ID)) e.META_PIXEL_ID = "ตัวเลขล้วน หรือเว้นว่าง";
  if (v.META_VERIFIED_IDENTITY_ID && !/^\d{5,}$/.test(v.META_VERIFIED_IDENTITY_ID)) e.META_VERIFIED_IDENTITY_ID = "ตัวเลขล้วน หรือเว้นว่าง";
  const budget = Number(v.MAX_DAILY_BUDGET_THB);
  if (!Number.isInteger(budget) || budget < 1 || budget > LIMITS.maxBudgetThb) e.MAX_DAILY_BUDGET_THB = `ต้องเป็น 1–${LIMITS.maxBudgetThb.toLocaleString()} บาท`;
  const perDay = Number(v.MAX_CAMPAIGNS_PER_DAY);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > LIMITS.maxCampaignsPerDay) e.MAX_CAMPAIGNS_PER_DAY = `ต้องเป็น 1–${LIMITS.maxCampaignsPerDay} แคมเปญ`;
  if (!/^v\d+\.\d+$/.test(v.GRAPH_API_VERSION ?? "")) e.GRAPH_API_VERSION = "รูปแบบ v21.0";
  if (v.DASHBOARD_API_URL && !/^https?:\/\/[^\s]+$/.test(v.DASHBOARD_API_URL)) e.DASHBOARD_API_URL = "ต้องขึ้นต้นด้วย http:// หรือ https://";
  if (input.token && !/^EAA[A-Za-z0-9]{20,}$/.test(input.token)) e.token = "รหัสต้องขึ้นต้นด้วย EAA และไม่มีช่องว่าง";
  if (input.secret && !/^[\x21-\x7e]{8,}$/.test(input.secret)) e.secret = "อย่างน้อย 8 ตัว ไม่มีช่องว่าง";
  if (input.aiKey && !AI_KEY_PATTERN.test(input.aiKey)) e.aiKey = "คีย์ต้องขึ้นต้นด้วย sk- และไม่มีช่องว่าง";
  if (v.AI_MODEL && !/^[A-Za-z0-9._:-]{2,80}$/.test(v.AI_MODEL)) e.AI_MODEL = "ชื่อรุ่น เช่น claude-haiku-5-5 หรือเว้นว่าง";
  if (v.ANTHROPIC_WORKSPACE_ID && !/^wrkspc_[A-Za-z0-9]{8,64}$/.test(v.ANTHROPIC_WORKSPACE_ID))
    e.ANTHROPIC_WORKSPACE_ID = "ต้องขึ้นต้นด้วย wrkspc_ ตามด้วยตัวอักษร/ตัวเลข หรือเว้นว่าง";
  return e;
}

/** เขียนทับเฉพาะบรรทัดที่เกี่ยว — คอมเมนต์และค่าอื่นในไฟล์คงเดิม */
export async function writeAgentEnv(a: AgentId, input: AgentEnvInput): Promise<void> {
  const { text } = await readText(a);
  const updates = new Map<string, string>([
    ["AGENT", a],
    ["AGENT_PREFIX", PREFIX[a]],
    ...EDITABLE_KEYS.map((k) => [k, input.values[k].trim()] as [string, string]),
  ]);
  if (input.token) updates.set("META_ACCESS_TOKEN", input.token.trim());
  if (input.secret) updates.set("DASHBOARD_API_SECRET", input.secret.trim());
  if (input.aiKey) updates.set(AI_KEY[a].name, input.aiKey.trim());
  // พอร์ตเพิ่มเติม: ลบ = ตัดทุกบรรทัดของพอร์ตนั้นออก · เพิ่ม/แก้ = เขียนทับรายช่อง (token ว่าง = ใช้ค่าเดิม)
  const dropSlots = new Set<number>();
  for (const p of input.portfolios ?? []) {
    if (p.remove) { dropSlots.add(p.slot); continue; }
    for (const k of PORTFOLIO_KEYS) updates.set(pfKey(p.slot, k), (p.values[k] ?? "").trim());
    if (p.token) updates.set(pfKey(p.slot, "TOKEN"), p.token.trim());
  }
  const dropped = (line: string) => {
    const hit = /^\s*META_PORTFOLIO_(\d)_/.exec(line);
    return !!hit && dropSlots.has(Number(hit[1]));
  };

  const done = new Set<string>();
  const lines = text.split(/\r?\n/).filter((line) => !dropped(line)).map((line) => {
    const hit = /^(\s*)([A-Z0-9_]+)(\s*)=/.exec(line);
    if (!hit || !updates.has(hit[2]) || done.has(hit[2])) return line;
    done.add(hit[2]);
    return `${hit[2]}=${updates.get(hit[2])}`;
  });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [k, v] of updates) if (!done.has(k)) lines.push(`${k}=${v}`);

  const file = envPath(a);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, lines.join("\n") + "\n", "utf8");
  await fs.rename(tmp, file);
}
