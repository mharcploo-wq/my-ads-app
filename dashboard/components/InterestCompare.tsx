"use client";
import { ReactNode, useEffect, useRef, useState } from "react";
import type { AdCopy, Interest, PickerAgent } from "@/components/InterestPicker";
import { fmtSize } from "@/components/InterestPicker";
import { AiRun, fmtWait, stopAiTask, thinkInterests, Waiting } from "@/lib/interestAi";

type AgentId = "claude" | "manus" | "chatgpt";
/** agent ในกล่องเทียบ (ลำดับ/ชื่อ/สีมาจากฟอร์ม) */
export interface CompareAgent { id: AgentId; label: string; color: string }
/** สถานะ agent ที่กล่องนี้ใช้ (จาก /api/agents) */
type CmpStatus = PickerAgent & { configured?: boolean; reason?: string };
interface Reach { lower: number; upper: number }
interface Running { since: number; wait: Waiting | null }

/** ⚖️ เทียบความสนใจ 3 AI — โจทย์เดียวกัน แต่ละตัวคิดเองด้วยคีย์ของตัวเอง (ไม่ยืมกัน) · ป้ายซ้ำนับจากชุดที่มีรายการแล้ว */
export default function InterestCompare({ agents, list, current, lists, runs, copy, locked, onResult, onUse, onBusy, renderCreate }: {
  agents: CmpStatus[] | null;
  list: CompareAgent[];
  current: AgentId;
  lists: Record<AgentId, Interest[]>;
  runs: Record<AgentId, AiRun | null>;
  copy: () => AdCopy;
  locked: boolean;                                    // กล่องความสนใจด้านบนกำลังทำงาน / กำลังสร้าง
  onResult: (agent: AgentId, interests: Interest[], run: AiRun) => void;
  onUse: (agent: AgentId) => void;                    // สลับผู้สร้างไปใช้ชุดนี้
  onBusy: (agents: AgentId[]) => void;                // agent ที่กำลังคิดอยู่ (ให้ฟอร์มล็อกกล่องด้านบน)
  renderCreate?: (agent: AgentId) => ReactNode;       // 🚀 สร้างแคมเปญจากชุดนี้ (ท้ายคอลัมน์)
}) {
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

  // คนไทยรวมของแต่ละชุด — ถาม Meta ด้วย token ของ agent นั้น (รอให้หยุดแก้ก่อนสักครู่ · ชุดเดิมไม่ถามซ้ำ)
  const reachKeys = list.map((a) => {
    const ids = lists[a.id].filter((x) => !x.gone).map((x) => x.id);
    return ids.length ? `${a.id}:${ids.join(",")}` : "";
  }).filter(Boolean);
  const reachSig = reachKeys.join("|");
  useEffect(() => {
    const todo = reachSig.split("|").filter((k) => k && !(k in reach));
    if (!todo.length) return;
    const t = setTimeout(() => {
      for (const k of todo) {
        const [a, ids] = k.split(":");
        setReach((m) => ({ ...m, [k]: null }));
        fetch("/api/interests", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: a, mode: "reach", ids: ids.split(",") }),
        }).then((r) => r.json()).then((j) => {
          setReach((m) => ({ ...m, [k]: j.ok && j.result.success ? { lower: j.result.lower, upper: j.result.upper } : false }));
        }).catch(() => setReach((m) => ({ ...m, [k]: false })));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [reachSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const aiOf = (id: AgentId) => agents?.find((s) => s.agent === id)?.audience?.ai ?? null;
  const statusOf = (id: AgentId) => agents?.find((s) => s.agent === id) ?? null;
  // คิดความสนใจใช้แค่คีย์ AI + คลังความสนใจของ Meta (ไม่แตะบัญชีโฆษณา) → ไม่ต้องรอ agent พร้อมสร้าง (เหมือนปุ่ม ✨ ด้านบน)
  const canRun = (id: AgentId) => !!aiOf(id)?.ready && !running[id] && !(locked && id === current);

  async function run(id: AgentId) {
    if (!canRun(id)) return;
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
  function stop(id: AgentId) {
    cancel.current[id] = true;
    const t = running[id]?.wait?.task_id;
    if (t) stopAiTask(id, t);
  }

  // ป้ายซ้ำ: นับว่าความสนใจนี้อยู่ในกี่ชุด (เฉพาะชุดที่มีรายการแล้ว)
  const filled = list.filter((a) => lists[a.id].length > 0);
  const count = new Map<string, number>();
  for (const a of filled) for (const x of lists[a.id]) count.set(x.id, (count.get(x.id) ?? 0) + 1);
  const tally = { 3: 0, 2: 0, 1: 0 } as Record<number, number>;
  for (const n of count.values()) tally[Math.min(n, 3)] += 1;
  const anyReady = list.some((a) => canRun(a.id));
  const fmtAt = (t: number) => new Date(t).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  const fmtMs = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} วินาที`
    : `${Math.floor(ms / 60_000)} นาที ${Math.round((ms % 60_000) / 1000)} วินาที`;

  return (
    <div className="c-cmp">
      <div className="c-cmp-head">
        <div>
          <b>⚖️ เทียบความสนใจ 3 AI</b>
          <div className="c-hint">โจทย์เดียวกัน (ข้อความ · พาดหัว · คำอธิบาย · ลิงก์) — แต่ละตัวคิดเองด้วยคีย์ของตัวเอง ไม่ยืมกัน ไม่เห็นคำตอบกัน</div>
        </div>
        <button type="button" className="btn c-ai" disabled={!anyReady} onClick={() => list.forEach((a) => { if (canRun(a.id)) run(a.id); })}>
          ✨ ให้ทั้ง 3 คิด
        </button>
      </div>
      <div className="c-cmp-cols">
        {list.map((a) => {
          const st = statusOf(a.id);
          const ai = aiOf(a.id);
          const items = lists[a.id];
          const r = runs[a.id];
          const rn = running[a.id];
          const isCur = a.id === current;
          const rk = items.length ? `${a.id}:${items.filter((x) => !x.gone).map((x) => x.id).join(",")}` : "";
          const rc = rk ? reach[rk] : null;
          return (
            <div key={a.id} className={`c-cmp-col ${isCur ? "on" : ""}`} style={{ ["--c" as string]: a.color }}>
              <div className="c-cmp-title"><b>{a.label}</b><small>{ai?.label ?? "—"}</small>{isCur && <span className="c-cmp-cur">ใช้สร้างอยู่</span>}</div>
              {!agents ? <div className="c-cmp-empty">กำลังเช็คสถานะ…</div>
                : !ai ? <div className="c-cmp-empty">ยังไม่ได้ตั้งค่า agent นี้</div>
                : !ai.ready ? <div className="c-cmp-empty">ยังไม่ได้ตั้งคีย์ AI<small>{ai?.missing ?? ""}</small></div>
                : rn ? (
                  <div className="c-cmp-wait" role="status">
                    <span className="c-wait-dot" aria-hidden /> {ai.label} กำลังคิด {fmtWait(now - rn.since)}{ai.slow ? " · ปกติ 1–3 นาที" : ""}
                    {rn.wait && <div><button type="button" className="btn" onClick={() => stop(a.id)}>ยกเลิก</button></div>}
                  </div>
                ) : items.length === 0 ? (
                  <div className="c-cmp-empty">ยังไม่ได้คิด
                    <div><button type="button" className="btn" disabled={!canRun(a.id)} onClick={() => run(a.id)}>✨ ให้ {a.label} คิด</button></div>
                  </div>
                ) : null}
              {items.length > 0 && !rn && (
                <>
                  <ul className="c-cmp-list">
                    {items.map((x) => {
                      const n = count.get(x.id) ?? 1;
                      return (
                        <li key={x.id}>
                          <span>{x.gone && "⚠ "}{x.name}</span>
                          {filled.length >= 2 && <span className={`c-cmp-tag t${Math.min(n, 3)}`}>{n >= 2 ? `ซ้ำ ${n}/3` : "เฉพาะตัวนี้"}</span>}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="c-cmp-sum">
                    <div><b>{items.length}</b> ตัว · คนไทย {rc ? <b>{fmtSize(rc.lower, rc.upper)}</b> : rc === false ? "— (ถาม Meta ไม่ได้ตอนนี้)" : "…"}</div>
                    {r && <div>คิดเมื่อ {fmtAt(r.at)} · {fmtMs(r.ms)}</div>}
                    {r?.audience?.label && <div>💡 แนะนำ {r.audience.label}</div>}
                    <div className="c-cmp-act">
                      {ai?.ready && <button type="button" className="btn" disabled={!canRun(a.id)} onClick={() => run(a.id)}>✨ คิดใหม่</button>}
                      {!isCur && <button type="button" className="btn c-cmp-use" disabled={!st?.configured || locked}
                        title={!st?.configured ? st?.reason : undefined} onClick={() => onUse(a.id)}>ใช้ {a.label} สร้าง →</button>}
                    </div>
                  </div>
                </>
              )}
              {errs[a.id] && <div className="c-warn">✕ {errs[a.id]}</div>}
              {!rn && renderCreate?.(a.id)}
            </div>
          );
        })}
      </div>
      {filled.length >= 2 && (
        <div className="c-hint">สรุป: ซ้ำทั้ง 3 = <b className="c-cmp-n3">{tally[3]} ตัว</b> · ซ้ำ 2 = <b className="c-cmp-n2">{tally[2]} ตัว</b> · เฉพาะตัวเดียว = {tally[1]} ตัว
          {filled.length < 3 && " · ป้ายนับจากชุดที่มีรายการแล้ว"}</div>
      )}
    </div>
  );
}
