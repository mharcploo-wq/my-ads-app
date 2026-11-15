import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { AgentId, Made } from "./madeTypes";

/** แคมเปญที่สร้างจากชุดความสนใจของ AI แต่ละตัว (ฟอร์มสร้าง) — เก็บในเครื่องนี้ (data/ ไม่เข้า git)
 *  ใช้กันสร้างซ้ำจากกล่องเทียบ 3 AI · เปิดจากเบราว์เซอร์ไหนก็เห็นตรงกัน · ปุ่มรีเซ็ตฟอร์มล้างทิ้ง */
const FILE = path.join(process.cwd(), "data", "made.json");
const IDS: AgentId[] = ["claude", "manus", "chatgpt"];

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export async function readMade(): Promise<Partial<Record<AgentId, Made>>> {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, Made | null>;
    const out: Partial<Record<AgentId, Made>> = {};
    for (const a of IDS) {
      const m = raw?.[a];
      if (m && typeof m.campaign_id === "string" && Array.isArray(m.interest_ids)) out[a] = m;
    }
    return out;
  } catch {
    return {};
  }
}

async function write(m: Partial<Record<AgentId, Made>>) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(m, null, 1), "utf8");
  await fs.rename(tmp, FILE);
}

/** จำผลของ agent (null = ลืม) */
export function setMade(agent: AgentId, m: Made | null) {
  return serial(async () => {
    const cur = await readMade();
    if (m) cur[agent] = m; else delete cur[agent];
    await write(cur);
  });
}

export function clearMade() {
  return serial(() => write({}));
}
