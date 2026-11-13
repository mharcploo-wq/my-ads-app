"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import InterestPicker, { Interest, PickerAgent } from "@/components/InterestPicker";

type AgentId = "claude" | "manus" | "chatgpt";
interface Info {
  adset_id: string; adset_name: string; campaign_name: string; paused: boolean; max_interests: number;
  interests: Interest[]; texts: string[]; titles: string[]; link_url: string;
}

/** กล่อง "＋ เพิ่มความสนใจให้ Ad Set นี้" — ใช้กับ Ad Set ที่สร้างไปแล้ว (เปิดจากการ์ดผลหลังสร้าง หรือจากตารางแคมเปญ)
 *  บันทึก = แทนที่ความสนใจชุดเดิมทั้งหมด · server.py ยอมเฉพาะงานของ agent นี้ที่หยุดอยู่ (PAUSED) */
export default function AdsetInterests({ agent, adsetId, campaignId, agents, onClose }: {
  agent: AgentId;
  adsetId?: string;
  campaignId?: string;
  agents?: PickerAgent[] | null;   // ไม่ส่งมา = โหลดเอง (ใช้กับปุ่ม ✨)
  onClose: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [list, setList] = useState<Interest[]>([]);
  const [agentList, setAgentList] = useState<PickerAgent[] | null>(agents ?? null);
  const [pickBusy, setPickBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const kwRef = useRef<HTMLInputElement>(null);

  const call = useCallback(async (extra: Record<string, unknown> = {}) => {
    const r = await fetch("/api/adset", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, adset_id: adsetId, campaign_id: campaignId, ...extra }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    if (!j.result.success) throw new Error(j.result.error);
    return j.result;
  }, [agent, adsetId, campaignId]);

  useEffect(() => {
    call().then((res: Info) => { setInfo(res); setList(res.interests); }).catch((e: Error) => setLoadErr(e.message));
  }, [call]);
  useEffect(() => {
    if (agents) return;
    fetch("/api/agents", { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j.ok) setAgentList(j.agents); }).catch(() => {});
  }, [agents]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, saving]);
  useEffect(() => { setConfirm(false); setSaveErr(null); }, [list]);

  const before = info?.interests ?? [];
  const changed = !!info && (list.length !== before.length || list.some((x, i) => x.id !== before[i]?.id));
  const gone = list.filter((x) => x.gone);
  const block = !info ? "" : !info.paused ? "แก้ได้เฉพาะตอนที่แคมเปญและ Ad Set หยุดอยู่ — กดหยุดใน Ads Manager ก่อน"
    : gone.length ? `ลบความสนใจที่ Meta เลิกใช้แล้วก่อน: ${gone.map((x) => x.name).join(", ")}`
    : !changed ? "ยังไม่ได้เปลี่ยนอะไร" : "";

  async function save() {
    setSaving(true); setSaveErr(null);
    try {
      const res = await call({ save: true, interests: list.map(({ id, name }) => ({ id, name })) });
      setSaved(res.interests.length);
      setInfo({ ...info!, interests: list });
      setConfirm(false);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="card modal" role="dialog" aria-modal="true" aria-label="เพิ่มความสนใจให้ Ad Set">
        <div className="modal-h">
          <h3>＋ เพิ่มความสนใจให้ Ad Set นี้</h3>
          <button className="btn" onClick={onClose} disabled={saving} aria-label="ปิด">✕</button>
        </div>
        {!info && !loadErr && <p className="hint">กำลังอ่าน Ad Set จาก Meta…</p>}
        {loadErr && <div className="c-warn">{loadErr}</div>}
        {info && (<>
          <p className="hint">
            {info.adset_name} · แคมเปญ {info.campaign_name} · {info.paused ? "หยุดอยู่" : "กำลังวิ่ง"}
            {" · "}ตอนนี้มีความสนใจ {before.length} รายการ
          </p>
          {saved !== null ? (
            <div className="c-result ok">
              <b>✔ บันทึกแล้ว — Ad Set นี้มีความสนใจ {saved} รายการ</b>
              <div className="c-hint" style={{ marginTop: 4 }}>สถานะยังหยุดอยู่เหมือนเดิม · เปิดวิ่งเองใน Ads Manager เมื่อพร้อม</div>
              <div className="c-actions"><button className="btn primary" onClick={onClose}>ปิด</button></div>
            </div>
          ) : (<>
            <InterestPicker agent={agent} agents={agentList} interests={list} setInterests={setList}
              max={info.max_interests} kwRef={kwRef} onBusy={setPickBusy} action="บันทึก"
              copyHint={`ข้อความของโฆษณาเดิม${info.titles.length ? " + พาดหัว" : ""}${info.link_url ? " + ลิงก์" : ""}`}
              copy={() => ({ texts: info.texts, titles: info.titles, link_url: info.link_url })} />
            <div className="c-actions">
              <button className="btn primary" disabled={!!block || pickBusy || saving} onClick={() => setConfirm(true)}>บันทึกลง Ad Set</button>
              <button className="btn" onClick={onClose} disabled={saving}>ยกเลิก</button>
              {block && <span className="c-hint">{block}</span>}
            </div>
            {confirm && !block && (
              <div className="c-confirm" role="alertdialog" aria-label="ยืนยันบันทึกความสนใจ">
                <b>{list.length ? `Ad Set นี้จะได้ความสนใจ ${list.length} รายการ` : "Ad Set นี้จะไม่มีความสนใจ"}{before.length ? ` (เดิม ${before.length})` : ""}</b>
                <div>{list.length ? list.map((x) => x.name).join(" · ") : `ลบออกทั้ง ${before.length} รายการ — Meta จะหากลุ่มเองจากทั้งประเทศ`}</div>
                <div>แทนที่ชุดเดิมทั้งหมด · ส่วนอื่นไม่เปลี่ยน (อายุ ภาษา งบ) · ยังหยุดอยู่เหมือนเดิม</div>
                <div className="c-actions">
                  <button className="btn primary" disabled={saving} onClick={save}>{saving ? "กำลังส่งไป Meta…" : "ยืนยัน ส่งไป Meta"}</button>
                  <button className="btn" disabled={saving} onClick={() => { setConfirm(false); kwRef.current?.focus(); }}>กลับไปแก้</button>
                </div>
              </div>
            )}
            {saveErr && <div className="c-warn" style={{ marginTop: 12 }}>{saveErr}</div>}
          </>)}
        </>)}
      </div>
    </div>
  );
}
