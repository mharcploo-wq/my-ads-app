"use client";
import { Dispatch, RefObject, SetStateAction, useEffect, useState } from "react";

type AgentId = "claude" | "manus" | "chatgpt";

/** ความสนใจจากคลังของ Meta · gone = Meta เลิกใช้แล้ว (ต้องลบก่อนบันทึก) */
export interface Interest { id: string; name: string; size_lower?: number | null; size_upper?: number | null; gone?: boolean }
export interface PickerAI { provider: string; label: string; ready: boolean; missing: string | null }
/** ส่วนของสถานะ agent ที่กล่องนี้ใช้ (มาจาก /api/agents) */
export interface PickerAgent { agent: AgentId; prefix: string; audience?: { ai: PickerAI } }
export interface AdCopy { texts: string[]; titles: string[]; link_url: string }
/** อายุ/ภาษาที่ AI แนะนำ — server.py ตัดให้อยู่ในช่วงที่ Meta รับแล้ว */
export interface AudienceHint { age_min: number; age_max: number; languages: string[]; label: string; reason: string }

/** ขนาดกลุ่มคนจาก Meta เช่น 150,000,000–176,000,000 → "≈150–176 ล้าน" · 86,760–102,030 → "≈87–102 พัน" */
export const fmtSize = (lo?: number | null, hi?: number | null) => {
  if (!lo || !hi) return "";
  const [d, unit] = hi >= 1e6 ? [1e6, "ล้าน"] : [1e3, "พัน"];
  return `≈${Math.max(1, Math.round(lo / d))}–${Math.max(1, Math.round(hi / d))} ${unit}`;
};

/** กล่องเลือกความสนใจ — ใช้ทั้งตอนสร้างโฆษณาและตอนเพิ่มให้ Ad Set ที่สร้างไปแล้ว
 *  ✨ ให้ AI คิดจากข้อความโฆษณา · ยืม Claude ของ agent อื่นเมื่อ AI ของตัวเองใช้ไม่ได้ · พิมพ์คำค้นเองค้นใน Meta */
export default function InterestPicker({ agent, agents, interests, setInterests, max, copy, copyHint, kwRef, onBusy, action = "กดสร้าง", onAudience }: {
  agent: AgentId;
  agents: PickerAgent[] | null;
  interests: Interest[];
  setInterests: Dispatch<SetStateAction<Interest[]>>;
  max: number;
  copy: () => AdCopy;            // ข้อความโฆษณาที่ให้ AI คิด
  copyHint: string;              // เช่น "ข้อความหลัก + ลิงก์"
  kwRef?: RefObject<HTMLInputElement | null>;
  onBusy?: (busy: boolean) => void;
  action?: string;               // คำของปุ่มส่งงาน เช่น "กดสร้าง" / "บันทึก"
  onAudience?: (a: AudienceHint) => void;   // มี = แสดงอายุ/ภาษาที่ AI แนะนำ พร้อมปุ่ม "ใช้ค่านี้"
}) {
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aiDown, setAiDown] = useState(false);   // AI ของ agent นี้ล้มรอบล่าสุด → เสนอให้ยืม Claude
  const [kw, setKw] = useState("");
  const [kwBusy, setKwBusy] = useState(false);
  const [hint, setHint] = useState<AudienceHint | null>(null);   // อายุ/ภาษาที่ AI แนะนำ (กดใช้เอง)

  const cur = agents?.find((a) => a.agent === agent) ?? null;
  const ai = cur?.audience?.ai ?? null;   // AI ของ agent ที่เลือก (คีย์แยกต่อ agent)
  // AI ของ agent นี้ใช้ไม่ได้ → ยืม Claude ของ agent อื่นที่พร้อม (เลือก agent Claude ก่อน) · ผลยังเป็นของ agent เดิม
  const claudeReady = (agents ?? []).filter((a) => a.agent !== agent && a.audience?.ai.ready && a.audience.ai.provider === "anthropic");
  const fallback = (!ai?.ready || aiDown) ? (claudeReady.find((a) => a.agent === "claude") ?? claudeReady[0] ?? null) : null;
  useEffect(() => { setAiDown(false); setAiMsg(null); }, [agent]);
  useEffect(() => { onBusy?.(aiBusy || kwBusy); }, [aiBusy, kwBusy, onBusy]);

  /** ปุ่ม ✨ — via = ยืม AI ของ agent อื่น */
  async function suggest(via?: PickerAgent) {
    if (aiBusy || kwBusy || (!via && !ai?.ready)) return;
    const c = copy();
    if (!c.texts.length) { setAiMsg({ ok: false, text: "ใส่ข้อความโฆษณาก่อน แล้วค่อยให้ AI คิดกลุ่มเป้าหมาย" }); return; }
    setAiBusy(true); setAiMsg(null);
    try {
      const r = await fetch("/api/interests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, ai_agent: via?.agent, ...c }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      if (!j.result.success) throw new Error(j.result.error);
      setInterests(j.result.interests);   // กดซ้ำ = แทนที่ชุดเดิมทั้งหมด
      if (j.result.audience) setHint(j.result.audience);
      if (!via) setAiDown(false);
      setAiMsg({ ok: true, text: `${j.result.ai}${via ? " (ยืมมาใช้แทน)" : ""} คิดจากข้อความ ได้ ${j.result.interests.length} รายการ` });
    } catch (e) {
      if (!via) setAiDown(true);
      setAiMsg({ ok: false, text: (e as Error).message });
    } finally {
      setAiBusy(false);
    }
  }

  /** ช่องพิมพ์คำค้น — คำสั้นคั่นด้วย , ค้นตรงใน Meta · เป็นประโยค server.py ให้ AI อ่านก่อน · ต่อท้ายรายการเดิม */
  async function search() {
    if (aiBusy || kwBusy) return;
    const text = kw.trim();
    if (!text) { setAiMsg({ ok: false, text: "พิมพ์คำค้น เช่น ERP, บัญชี หรือเล่าว่าขายอะไรให้ใคร" }); return; }
    setKwBusy(true); setAiMsg(null);
    const ask = async (via?: PickerAgent) => {
      const r = await fetch("/api/interests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, ai_agent: via?.agent, mode: "search", text, have: interests.map((x) => x.id), ...copy() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      return j.result;
    };
    try {
      let via = fallback ?? undefined;
      let res = await ask(via);
      // ประโยคต้องใช้ AI — AI ของ agent นี้ล้ม (เช่น เครดิตหมด) → ยืม Claude อ่านแทนอัตโนมัติ 1 ครั้ง
      const spare = claudeReady.find((a) => a.agent === "claude") ?? claudeReady[0];
      if (!res.success && res.brief && !via && spare) {
        setAiDown(true);
        via = spare;
        res = await ask(via);
      }
      if (!res.success) throw new Error(res.error);
      const got: Interest[] = res.interests;
      setInterests((cur) => [...cur, ...got.filter((x) => !cur.some((c) => c.id === x.id))]);
      setKw("");
      if (res.audience) setHint(res.audience);
      const miss = [...(res.missed ?? []), ...(res.skipped ?? [])];
      const who = res.brief ? `${res.ai}${via ? ` (ยืมของ ${via.prefix})` : ""} อ่านประโยค → ` : "";
      setAiMsg({ ok: true, text: `${who}ค้นใน Meta ได้ ${got.length} รายการ${miss.length ? ` · ไม่ได้เพิ่ม: ${miss.join(", ")}` : ""}` });
    } catch (e) {
      setAiMsg({ ok: false, text: (e as Error).message });
    } finally {
      setKwBusy(false);
    }
  }

  return (
    <div className="c-int">
      <div className="c-aud-row c-int-bar">
        <button type="button" className="btn c-ai" onClick={() => suggest()} disabled={!ai?.ready || aiBusy || kwBusy}>
          {aiBusy ? "AI กำลังคิด…" : "✨ ให้ AI คิดกลุ่มเป้าหมาย"}
        </button>
        {ai?.ready && !aiBusy && <span className="c-hint">{ai.label} คิดจาก{copyHint}</span>}
        <span className="c-cnt">{interests.length} / {max}</span>
      </div>
      {interests.length > 0 && (
        <div className="c-chips">
          {interests.map((it) => (
            <span key={it.id} className={`c-itag ${it.gone ? "gone" : ""}`} title={it.gone ? "Meta เลิกใช้ความสนใจนี้แล้ว — ต้องลบออกก่อนบันทึก" : undefined}>
              {it.gone && "⚠ "}{it.name} {fmtSize(it.size_lower, it.size_upper) && <small>{fmtSize(it.size_lower, it.size_upper)}</small>}
              {it.gone && <small>Meta เลิกใช้แล้ว</small>}
              <button type="button" aria-label={`ลบความสนใจ ${it.name}`} onClick={() => setInterests(interests.filter((x) => x.id !== it.id))}>✕</button>
            </span>
          ))}
        </div>
      )}
      {ai && !ai.ready && <div className="c-warn">{ai.missing}</div>}
      {aiMsg && <div className={aiMsg.ok ? "c-hint" : "c-warn"}>{aiMsg.ok ? "✓ " : "✕ "}{aiMsg.text}</div>}
      {hint && onAudience && (
        <div className="c-aud-hint">
          <span>💡 AI แนะนำ <b>{hint.label}</b>{hint.reason && <small> — {hint.reason}</small>}</span>
          <span className="c-aud-hint-act">
            <button type="button" className="btn" onClick={() => { onAudience(hint); setHint(null); setAiMsg({ ok: true, text: `ใช้ค่าแนะนำแล้ว: ${hint.label}` }); }}>ใช้ค่านี้</button>
            <button type="button" className="btn" onClick={() => setHint(null)}>ไม่ใช้</button>
          </span>
        </div>
      )}
      {fallback && !aiBusy && (
        <div className="c-aud-row c-int-bar">
          <button type="button" className="btn" onClick={() => suggest(fallback)} disabled={kwBusy}>
            ✨ ใช้ {fallback.audience!.ai.label} หาแทนรอบนี้
          </button>
          <span className="c-hint">ยืม AI ของ {fallback.prefix} · โฆษณายังเป็นของ {cur?.prefix ?? agent} เหมือนเดิม</span>
        </div>
      )}
      <div className="c-aud-row c-int-bar">
        <input ref={kwRef} className="input c-kw" value={kw} maxLength={200} aria-label="พิมพ์คำค้นความสนใจเอง"
          placeholder="พิมพ์คำค้น เช่น ERP, บัญชี — หรือเล่าว่าขายอะไรให้ใคร ให้ AI อ่าน" onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        <button type="button" className="btn" onClick={search} disabled={kwBusy || aiBusy || !kw.trim()}>
          {kwBusy ? "กำลังค้น…" : "ค้นใน Meta"}
        </button>
      </div>
      <div className="c-hint">คำสั้นคั่นด้วย , = ค้นตรงในคลังของ Meta · พิมพ์เป็นประโยค = AI อ่านแล้วหาให้ (+ แนะนำอายุ/ภาษา) · เพิ่มต่อท้ายรายการเดิม</div>
      {interests.length > 0 && <div className="c-hint">ค่าแนะนำ · Meta อาจขยายไปคนนอกกลุ่มนี้ถ้าได้ผลดีกว่า · ลบได้ก่อน{action}</div>}
    </div>
  );
}
