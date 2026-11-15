"use client";
import { ReactNode, useEffect, useRef, useState } from "react";
import type { AdCopy, Interest, PickerAgent } from "@/components/InterestPicker";
import { fmtSize } from "@/components/InterestPicker";
import { AiRun, fmtWait, stopAiTask, thinkInterests, Waiting } from "@/lib/interestAi";

type AgentId = "claude" | "manus" | "chatgpt";
/** agent ในฟอร์ม (ลำดับ/ชื่อ/สีมาจากฟอร์ม) */
export interface CompareAgent { id: AgentId; label: string; color: string }
/** สถานะ agent ที่กล่องนี้ใช้ (จาก /api/agents) */
type CmpStatus = PickerAgent & { configured?: boolean; reason?: string };
interface Reach { lower: number; upper: number }
interface Running { since: number; wait: Waiting | null }

/** 🎯 ชุดความสนใจของ AI ในหน้าที่เลือก — หน้า Claude ให้ Claude คิดคนเดียว (Manus/ChatGPT เหมือนกัน) · ไม่ยืม AI ตัวอื่น
 *  ชุดของตัวอื่นไม่แสดงในหน้านี้ — สลับที่ "สร้างในนาม" ด้านบน */
export default function InterestCompare({ agents, list, current, lists, runs, copy, locked, onResult, onBusy, renderCreate }: {
  agents: CmpStatus[] | null;
  list: CompareAgent[];
  current: AgentId;
  lists: Record<AgentId, Interest[]>;
  runs: Record<AgentId, AiRun | null>;
  copy: () => AdCopy;
  locked: boolean;                                    // กล่องความสนใจด้านบนกำลังทำงาน / กำลังสร้าง
  onResult: (agent: AgentId, interests: Interest[], run: AiRun) => void;
  onBusy: (agents: AgentId[]) => void;                // agent ที่กำลังคิดอยู่ (ให้ฟอร์มล็อกกล่องด้านบน)
  renderCreate?: (agent: AgentId) => ReactNode;       // 🚀 สร้างแคมเปญจากชุดนี้ (ท้ายกล่อง)
}) {
  // เก็บต่อ agent: สลับหน้าระหว่างคิด งานเดิมยังรอผลต่อ แล้วไปขึ้นในหน้าของตัวนั้น
  const [running, setRunning] = useState<Partial<Record<AgentId, Running>>>({});
  const [errs, setErrs] = useState<Partial<Record<AgentId, string>>>({});
  const [reach, setReach] = useState<Record<string, Reach | null | false>>({});   // key = agent:ids · null = กำลังถาม · false = ถามไม่ได้
  const [now, setNow] = useState(() => Date.now());
  const cancel = useRef<Partial<Record<AgentId, boolean>>>({});
  const tasks = useRef<Partial<Record<AgentId, string>>>({});   // งาน Manus ที่ค้างอยู่ (ออกจากหน้า = ยกเลิกให้)

  const busyIds = (Object.keys(running) as AgentId[]).filter((a) => running[a]);
  const busyKey = busyIds.join(",");
  useEffect(() => { onBusy(busyKey ? busyKey.split(",") as AgentId[] : []); }, [busyKey, onBusy]);
  useEffect(() => {
    if (!busyKey) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busyKey]);
  useEffect(() => () => {
    for (const [a, id] of Object.entries(tasks.current)) if (id) stopAiTask(a, id);
  }, []);

  const me = list.find((a) => a.id === current) ?? list[0];
  const st = agents?.find((s) => s.agent === me.id) ?? null;
  const ai = st?.audience?.ai ?? null;
  const items = lists[me.id];
  const r = runs[me.id];
  const rn = running[me.id];
  const ids = items.filter((x) => !x.gone).map((x) => x.id);
  const rk = ids.length ? `${me.id}:${ids.join(",")}` : "";
  const rc = rk ? reach[rk] : null;

  // คนไทยรวมของชุดนี้ — ถาม Meta ด้วย token ของ agent นี้ (รอให้หยุดแก้ก่อนสักครู่ · ชุดเดิมไม่ถามซ้ำ)
  useEffect(() => {
    if (!rk || rk in reach) return;
    const t = setTimeout(() => {
      setReach((m) => ({ ...m, [rk]: null }));
      fetch("/api/interests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: me.id, mode: "reach", ids }),
      }).then((x) => x.json()).then((j) => {
        setReach((m) => ({ ...m, [rk]: j.ok && j.result.success ? { lower: j.result.lower, upper: j.result.upper } : false }));
      }).catch(() => setReach((m) => ({ ...m, [rk]: false })));
    }, 700);
    return () => clearTimeout(t);
  }, [rk]); // eslint-disable-line react-hooks/exhaustive-deps

  // คิดความสนใจใช้แค่คีย์ AI + คลังความสนใจของ Meta (ไม่แตะบัญชีโฆษณา) → ไม่ต้องรอ agent พร้อมสร้าง (เหมือนปุ่ม ✨ ด้านบน)
  const canRun = !!ai?.ready && !rn && !locked;

  async function run() {
    const id = me.id;
    if (!canRun) return;
    const c = copy();
    if (!c.texts.length) { setErrs((m) => ({ ...m, [id]: "ใส่ข้อความโฆษณาก่อน แล้วค่อยให้ AI คิด" })); return; }
    cancel.current[id] = false;
    setErrs((m) => ({ ...m, [id]: undefined }));
    const t0 = Date.now();
    setRunning((m) => ({ ...m, [id]: { since: t0, wait: null } }));
    setNow(t0);
    try {
      const res = await thinkInterests(id, c, () => !!cancel.current[id], (w) => {
        tasks.current[id] = w?.task_id;
        setRunning((m) => (m[id] ? { ...m, [id]: { ...m[id]!, wait: w } } : m));
      });
      if (!res.success) throw new Error(res.error);
      onResult(id, res.interests, { ai: res.ai, at: Date.now(), ms: Date.now() - t0,
        audience: res.audience ? { label: res.audience.label } : null });
    } catch (e) {
      setErrs((m) => ({ ...m, [id]: (e as Error).message }));
    } finally {
      tasks.current[id] = undefined;
      setRunning((m) => ({ ...m, [id]: undefined }));
    }
  }
  function stop() {
    cancel.current[me.id] = true;
    const t = rn?.wait?.task_id;
    if (t) stopAiTask(me.id, t);
  }

  const fmtAt = (t: number) => new Date(t).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  const fmtMs = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} วินาที`
    : `${Math.floor(ms / 60_000)} นาที ${Math.round((ms % 60_000) / 1000)} วินาที`;

  return (
    <div className="c-cmp" style={{ ["--c" as string]: me.color }}>
      <div className="c-cmp-head">
        <div>
          <b>🎯 ชุดความสนใจของ {me.label}</b>
          <div className="c-hint">{ai?.label ?? me.label} คิดคนเดียวจากข้อความ · พาดหัว · คำอธิบาย · ลิงก์ — ไม่ยืม AI ตัวอื่น</div>
        </div>
      </div>
      <div className="c-cmp-col on">
        <div className="c-cmp-title"><b>{me.label}</b>{ai?.label !== me.label && <small>{ai?.label ?? "—"}</small>}</div>
        {!agents ? <div className="c-cmp-empty">กำลังเช็คสถานะ…</div>
          : !ai ? <div className="c-cmp-empty">ยังไม่ได้ตั้งค่า agent นี้</div>
          : !ai.ready ? <div className="c-cmp-empty">ยังไม่ได้ตั้งคีย์ AI<small>{ai.missing ?? ""}</small></div>
          : rn ? (
            <div className="c-cmp-wait" role="status">
              <span className="c-wait-dot" aria-hidden /> {ai.label} กำลังคิด {fmtWait(now - rn.since)}{ai.slow ? " · ปกติ 1–3 นาที" : ""}
              {rn.wait && <div><button type="button" className="btn" onClick={stop}>ยกเลิก</button></div>}
            </div>
          ) : items.length === 0 ? (
            <div className="c-cmp-empty">ยังไม่ได้คิด
              <div><button type="button" className="btn" disabled={!canRun} onClick={run}>✨ ให้ {me.label} คิด</button></div>
            </div>
          ) : null}
        {items.length > 0 && !rn && (
          <>
            <ul className="c-cmp-list">
              {items.map((x) => <li key={x.id}><span>{x.gone && "⚠ "}{x.name}</span></li>)}
            </ul>
            <div className="c-cmp-sum">
              <div><b>{items.length}</b> ตัว · คนไทย {rc ? <b>{fmtSize(rc.lower, rc.upper)}</b> : rc === false ? "— (ถาม Meta ไม่ได้ตอนนี้)" : "…"}</div>
              {r && <div>คิดเมื่อ {fmtAt(r.at)} · {fmtMs(r.ms)}</div>}
              {r?.audience?.label && <div>💡 แนะนำ {r.audience.label}</div>}
              {ai?.ready && <div className="c-cmp-act"><button type="button" className="btn" disabled={!canRun} onClick={run}>✨ คิดใหม่</button></div>}
            </div>
          </>
        )}
        {errs[me.id] && <div className="c-warn">✕ {errs[me.id]}</div>}
        {!rn && renderCreate?.(me.id)}
      </div>
    </div>
  );
}
