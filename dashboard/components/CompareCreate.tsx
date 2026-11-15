"use client";
import { useState } from "react";
import type { Made } from "@/lib/madeTypes";
import { interestSig } from "@/lib/madeTypes";

/** สรุปสิ่งที่จะสร้าง (ขึ้นในกล่องยืนยัน) */
export interface CreatePlan {
  name: string; page: string | null; kind: string; media: string; money: string; when: string; audience: string; left: string | null;
}
interface Step { key: string; label: string; ok: boolean; detail: string }
export interface CreateFail { msg: string; steps?: Step[] }

const fmtAt = (t: number) => new Date(t).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtRun = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** 🚀 สร้างแคมเปญจากชุดความสนใจของ AI ตัวหนึ่ง (ท้ายกล่องชุดความสนใจของหน้านั้น) — ถามยืนยันก่อน · สร้างได้ทีละแคมเปญ · สร้างแล้วจำไว้กันซ้ำ */
export default function CompareCreate({ label, ids, made, running, since, now, waitFor, blocked, plan, fail, onCreate }: {
  label: string;                      // ชื่อ AI ในคอลัมน์
  ids: string[];                      // ความสนใจในชุดตอนนี้
  made: Made | undefined;             // แคมเปญที่สร้างจากชุดนี้ไปแล้ว
  running: boolean;                   // คอลัมน์นี้กำลังสร้าง
  since: number | null; now: number;
  waitFor: string | null;             // ตัวอื่นกำลังสร้างอยู่ (ชื่อ) → ล็อก
  blocked: string[];                  // ยังขาดอะไร
  plan: CreatePlan;
  fail: CreateFail | undefined;
  onCreate: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [again, setAgain] = useState(false);   // กด "สร้างอีกแคมเปญ" หลังแก้ชุด

  if (!ids.length) return <div className="c-mk lock">🚀 สร้างไม่ได้ — ยังไม่มีชุดความสนใจ</div>;
  if (running) return (
    <div className="c-mk run" role="status">
      <b>⏳ กำลังสร้าง {plan.name}… {since ? fmtRun(now - since) : ""}</b>
      <div>อัปโหลดและรอ Meta ประมวลผล (มีคลิปอาจนานหลายนาที) · อย่าปิดหน้านี้</div>
    </div>
  );
  const changed = made ? interestSig(made.interest_ids) !== interestSig(ids) : false;
  const go = () => { setConfirm(false); setAgain(false); onCreate(); };
  const locked = !!waitFor || blocked.length > 0;

  if (confirm && !locked) return (
    <div className="c-mk cf" role="alertdialog" aria-label={`ยืนยันสร้างในนาม ${label}`}>
      <b>ยืนยันสร้างในนาม {label}?</b>
      <div>
        📛 <b>{plan.name}</b> · {plan.kind}<br />
        📄 เพจ {plan.page ?? "เพจประจำ"} · 🎯 ความสนใจ {label} {ids.length} ตัว<br />
        {plan.media}<br />
        💰 {plan.money} · {plan.when}<br />
        👤 {plan.audience}
      </div>
      <div className="c-hint">⏸ สร้างแบบหยุดไว้ — ยังไม่เสียเงินจนกว่าจะกดเปิดใน Ads Manager{plan.left ? ` · ${plan.left}` : ""}</div>
      <div className="c-cmp-act">
        <button type="button" className="btn c-go" onClick={go}>ยืนยัน สร้างแคมเปญ</button>
        <button type="button" className="btn" onClick={() => { setConfirm(false); setAgain(false); }}>ยกเลิก</button>
      </div>
    </div>
  );

  if (made && !again && !fail) return (
    <div className="c-mk ok">
      <b>✔ สร้างแล้ว {fmtAt(made.at)} · {made.campaign_name}</b>
      <div className="c-mono">แคมเปญ {made.campaign_id}{made.adset_id ? <><br />ชุด {made.adset_id}</> : null}{made.ads ? ` · ${made.ads} โฆษณา` : ""}</div>
      {changed && <div className="c-mk-warn">⚠ ความสนใจในชุดนี้เปลี่ยนไปหลังสร้าง (แคมเปญที่สร้างแล้วไม่เปลี่ยนตาม)</div>}
      <div className="c-cmp-act">
        {made.url && <a className="btn" href={made.url} target="_blank" rel="noreferrer">เปิดใน Ads Manager ↗</a>}
        {changed && <button type="button" className="btn" disabled={locked} title={locked ? (waitFor ? `รอ ${waitFor} สร้างเสร็จก่อน` : blocked.join(" · ")) : undefined}
          onClick={() => { setAgain(true); setConfirm(true); }}>สร้างอีกแคมเปญ</button>}
      </div>
    </div>
  );

  return (
    <div className={`c-mk ${fail ? "bad" : ""}`}>
      {fail && <>
        <b>✖ สร้างไม่สำเร็จ</b>
        {fail.steps?.length ? <ul className="c-mk-steps">{fail.steps.map((s) => <li key={s.key}>{s.ok ? "✔" : "✖"} {s.label}{s.ok ? "" : ` — ${s.detail}`}</li>)}</ul>
          : <div>{fail.msg}</div>}
        {fail.steps?.some((s) => s.ok && /แคมเปญ/.test(s.label)) && <div className="c-hint">แคมเปญที่สร้างไปแล้วยังอยู่ (หยุดไว้) — ไปลบเองใน Ads Manager ก่อนลองใหม่ จะได้ไม่ซ้ำ</div>}
      </>}
      <button type="button" className="btn c-go" disabled={locked} onClick={() => setConfirm(true)}>
        {fail ? "🚀 ลองอีกครั้ง" : again ? "🚀 สร้างอีกแคมเปญจากชุดนี้" : "🚀 สร้างแคมเปญจากชุดนี้"}
      </button>
      <div className="c-hint">{waitFor ? `รอ ${waitFor} สร้างเสร็จก่อน — สร้างได้ทีละแคมเปญ`
        : blocked.length ? `ยังขาด: ${blocked.join(" · ")}`
        : `จะได้ ${plan.name} · ${ids.length} ความสนใจ · ${plan.money}`}</div>
      {fail && made && <div className="c-hint">แคมเปญเดิมที่สร้างไว้ ({made.campaign_id}) ยังอยู่</div>}
    </div>
  );
}
