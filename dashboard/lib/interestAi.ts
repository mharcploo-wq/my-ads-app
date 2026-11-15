"use client";
/** ให้ AI ของ agent คิดความสนใจจากข้อความโฆษณา (/api/interests) — ใช้ทั้งกล่องเลือกความสนใจและกล่องเทียบ 3 AI
 *  Manus ตอบ "กำลังคิด" → ถามผลทุก 5 วินาทีจนเสร็จ/ยกเลิก/ครบ 5 นาที · ได้ผลรูปเดียวกับค่ายอื่น */

export const POLL_MS = 5_000;            // ถามผล Manus ทุก 5 วินาที (Manus จำกัด 100 ครั้ง/นาที)
export const WAIT_MAX_MS = 5 * 60_000;   // รอนานสุด 5 นาที แล้วยกเลิกงานให้
/** เวลาที่รอ เช่น 0:42 · 2:05 */
export const fmtWait = (ms: number) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

/** งานที่สั่ง Manus ไว้ระหว่างรอ */
export interface Waiting { task_id: string; task_url: string; label: string; since: number }
/** ผลรอบล่าสุดที่ AI ของ agent คิด (เก็บไว้ในร่างเพื่อเทียบกัน) · audience = อายุ/ภาษาที่ AI แนะนำ (label สำเร็จรูปจาก server.py) */
export interface AiRun { ai: string; at: number; ms: number; audience?: { label: string } | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** สั่งเลิกงานที่ Manus (ไม่ให้กินเครดิตต่อ) — ไม่รอผล */
export function stopAiTask(agent: string, taskId: string) {
  fetch("/api/interests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, mode: "stop", task_id: taskId }),
  }).catch(() => {});
}

/** first = คำตอบ "กำลังคิด" จาก Manus · onWait(w) ตอนเริ่ม/จบรอ (null) · cancelled() = ผู้ใช้กดยกเลิก */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function waitForAi(agent: string, first: any, have: string[], cancelled: () => boolean,
  onWait: (w: Waiting | null) => void): Promise<any> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const w: Waiting = { task_id: first.task_id, task_url: first.task_url ?? "", label: first.ai ?? "Manus", since: Date.now() };
  const stopped = `ยกเลิกแล้ว — ${w.label} หยุดคิดงานนี้`;
  onWait(w);
  try {
    for (;;) {
      for (let t = 0; t < POLL_MS && !cancelled(); t += 250) await sleep(250);   // กดยกเลิกแล้วหยุดทันที
      if (cancelled()) throw new Error(stopped);
      if (Date.now() - w.since > WAIT_MAX_MS) {
        stopAiTask(agent, w.task_id);
        throw new Error(`${w.label} คิดนานเกิน 5 นาที — ยกเลิกงานให้แล้ว ลองกดใหม่อีกครั้ง`);
      }
      const r = await fetch("/api/interests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, mode: "poll", task_id: w.task_id, kind: first.kind, have }),
      });
      const j = await r.json();
      if (cancelled()) throw new Error(stopped);
      if (!j.ok) throw new Error(j.error);
      if (!j.result.pending) return j.result;
    }
  } finally {
    onWait(null);
  }
}

/** ✨ ให้ AI ของ agent คิดจากข้อความโฆษณา (ไม่ยืม AI ของ agent อื่น) → ผลของ server.py (success/interests/audience/ai/error) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function thinkInterests(agent: string, copy: object, cancelled: () => boolean,
  onWait: (w: Waiting | null) => void): Promise<any> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch("/api/interests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, ...copy }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result.success && j.result.pending ? waitForAi(agent, j.result, [], cancelled, onWait) : j.result;
}
