"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveAdsResult } from "@/lib/creator";

type AgentId = "claude" | "manus" | "chatgpt";
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

const fmtTh = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " น.";
};

/** เรียก server.py --live-ad-json ผ่าน /api/live-ad · คืนผลเต็ม (success=false ก็คืน ไม่ throw) */
async function callLiveAd(agent: AgentId, target: { adsetId?: string; campaignId?: string },
  mode: "info" | "teaser" | "live", extra: Record<string, string | File | undefined> = {}): Promise<LiveAdsResult> {
  const fd = new FormData();
  fd.set("agent", agent); fd.set("mode", mode);
  if (target.adsetId) fd.set("adset_id", target.adsetId);
  if (target.campaignId) fd.set("campaign_id", target.campaignId);
  Object.entries(extra).forEach(([k, v]) => { if (v) fd.set(k, v); });
  const r = await fetch("/api/live-ad", { method: "POST", body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result as LiveAdsResult;
}

/** ปุ่ม "🔴 สร้างโฆษณาจาก Live ที่กำลังออกอากาศ" + ผลลัพธ์ (ใช้ในการ์ดหลังสร้าง และในกล่อง ＋ โฆษณา) */
export function LiveOnAirButton({ agent, adsetId, liveName, pageId, onDone }: {
  agent: AgentId; adsetId: string; liveName?: string; pageId?: string; onDone?: (r: LiveAdsResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<LiveAdsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await callLiveAd(agent, { adsetId }, "live", { page_id: pageId });
      setRes(r);
      if (r.success) onDone?.(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="c-onair">
      <b>🔴 ตอน Live ออกอากาศ</b>
      <small className="c-hint">
        เริ่ม Live{liveName ? ` จากรายการ "${liveName}"` : ""} แล้วกดปุ่มนี้ → แอปหาคลิป Live บนเพจแล้วสร้างโฆษณาคลิป Live เพิ่มลงชุดเดิม
        (Meta ตรวจโฆษณาราว 5–20 นาที — กดทันทีที่เริ่ม Live)
      </small>
      <div className="c-actions">
        <button className="btn c-livebtn" disabled={busy} onClick={go}>
          {busy ? "กำลังหา Live บนเพจ…" : "🔴 สร้างโฆษณาจาก Live ที่กำลังออกอากาศ"}
        </button>
      </div>
      {err && <div className="c-warn">{err}</div>}
      {res && !res.success && <div className={res.not_live ? "c-wait" : "c-warn"}>{res.not_live ? "⏳ " : "✖ "}{res.error}</div>}
      {res?.success && (
        <div className="c-result ok">
          <b>✔ สร้างโฆษณาคลิป Live แล้ว</b>
          <ul>
            <li className="ok">✔ เจอ Live — &quot;{res.live_title}&quot;{res.live_started ? ` ออกอากาศตั้งแต่ ${res.live_started}` : ""}</li>
            <li className="ok">✔ โฆษณาคลิป Live — {res.name} · หยุดไว้</li>
          </ul>
          <small className="c-hint">ตอนนี้ชุดมี {res.ads ?? "?"} โฆษณา ทุกตัวหยุดอยู่ → เปิดเองใน Ads Manager · ถ้าอยากให้วิ่งแต่คลิป Live ก็ปล่อยโฆษณารูปหยุดไว้</small>
        </div>
      )}
    </div>
  );
}

/** กล่อง "＋ สร้างโฆษณาให้ชุดนี้" — เติมโฆษณาให้ชุด Live ที่สร้างไปแล้ว (เปิดจากตารางแคมเปญ)
 *  แท็บรูปชวนดู Live / คลิป Live ที่กำลังออกอากาศ · server.py สร้างเป็น PAUSED และยอมเฉพาะชุดของ agent นี้ */
export default function LiveAds({ agent, adsetId, campaignId, onClose }: {
  agent: AgentId; adsetId?: string; campaignId?: string; onClose: () => void;
}) {
  const [info, setInfo] = useState<LiveAdsResult | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"teaser" | "live">("teaser");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [liveId, setLiveId] = useState("");
  const [pageId, setPageId] = useState("");   // ชุดยังว่าง: เพจที่เลือกในกล่องนี้ ("" = เพจประจำ agent)
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<LiveAdsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadErr(null);
    callLiveAd(agent, { adsetId, campaignId }, "info", { page_id: pageId })
      .then((r) => {
        if (!r.success) throw new Error(r.error);
        setInfo(r);
        setLiveId((cur) => (r.lives?.some((l) => l.id === cur) ? cur : r.lives?.[0]?.id || ""));
        if (r.on_air) setTab("live");
      })
      .catch((e: Error) => setLoadErr(e.message));
  }, [agent, adsetId, campaignId, pageId]);
  useEffect(load, [load]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, busy]);

  async function makeTeaser() {
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await callLiveAd(agent, { adsetId: info!.adset_id }, "teaser", { live_id: liveId, text: text.trim(), image: file ?? undefined, page_id: pageChoice });
      if (!r.success) throw new Error(r.error);
      setRes(r);
      setInfo({ ...info!, ads: r.ads });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const lives = info?.lives ?? [];
  // ชุดที่มีโฆษณาแล้ว = เพจล็อกตามโฆษณาเดิม · ชุดว่าง = ส่งเพจที่เลือกไปด้วยทุกครั้ง
  const pageChoice = info && !info.page_locked ? info.page?.id : undefined;
  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="card modal" role="dialog" aria-modal="true" aria-label="สร้างโฆษณาให้ชุดนี้">
        <div className="modal-h">
          <h3>＋ สร้างโฆษณาให้ชุดนี้</h3>
          <button className="btn" onClick={onClose} disabled={busy} aria-label="ปิด">✕</button>
        </div>
        {!info && !loadErr && <p className="hint">กำลังอ่านชุดโฆษณาจาก Meta…</p>}
        {loadErr && <div className="c-warn">{loadErr}</div>}
        {info && (<>
          <p className="hint">
            {info.adset_name} · {info.ads == null ? "" : info.ads ? `มีโฆษณา ${info.ads} ตัว` : "ยังไม่มีโฆษณา"}
            {info.start_time ? ` · ${fmtTh(info.start_time)}–${fmtTh(info.end_time).replace(/^.* (\d\d:\d\d)/, "$1")}` : ""}
          </p>
          <div className="c-label">{info.page_locked ? "เพจของชุดนี้" : "ยิงในนามเพจ"}</div>
          {info.page_locked ? (
            <div className="c-page on" aria-disabled="true">
              <span className="c-page-t"><b>{info.page?.name}</b>
                <small>🔒 อ่านจากโฆษณาเดิมในชุด — โฆษณาใหม่ใช้เพจเดียวกัน · Live ที่นัดไว้ดึงจากเพจนี้</small></span>
            </div>
          ) : (<>
            <div className="c-pages" role="radiogroup" aria-label="เพจที่จะยิงโฆษณา">
              {(info.pages ?? []).map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={p.id === info.page?.id} disabled={busy}
                  className={`c-page ${p.id === info.page?.id ? "on" : ""}`} onClick={() => { if (p.id !== info.page?.id) { setInfo(null); setPageId(p.id); } }}>
                  <span className="c-radio" />
                  {p.picture ? <img className="c-page-av" src={p.picture} alt="" /> : <span className="c-page-av">{p.name.slice(0, 1)}</span>}
                  <span className="c-page-t"><b>{p.name}</b><small>{p.followers != null ? `ผู้ติดตาม ${p.followers.toLocaleString()}` : `เลขเพจ ${p.id}`}</small></span>
                </button>
              ))}
            </div>
            <small className="c-hint">ชุดนี้ยังไม่มีโฆษณา — เลือกเพจที่จะยิง (โฆษณาตัวต่อไปในชุดจะใช้เพจเดียวกันนี้)</small>
          </>)}
          <div className="c-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "teaser"} className={`btn ${tab === "teaser" ? "on" : ""}`} onClick={() => setTab("teaser")}>🖼 รูปชวนดู Live</button>
            <button role="tab" aria-selected={tab === "live"} className={`btn ${tab === "live" ? "on" : ""}`} onClick={() => setTab("live")}>
              🔴 คลิป Live ที่กำลังออกอากาศ{info.on_air ? " · ออกอากาศอยู่" : ""}
            </button>
          </div>

          {tab === "teaser" ? (res ? (
            <div className="c-result ok">
              <b>✔ สร้างโฆษณารูปชวนดู Live แล้ว</b>
              <ul><li className="ok">✔ {res.name} · หยุดไว้ · รูป: {res.image_source}</li></ul>
              <small className="c-hint">ตอนนี้ชุดมี {res.ads ?? "?"} โฆษณา · เปิดวิ่งเองใน Ads Manager เมื่อพร้อม</small>
              <div className="c-actions"><button className="btn primary" onClick={onClose}>ปิด</button></div>
            </div>
          ) : (<>
            <div className="field"><label htmlFor="la-text">ข้อความชวนดู Live <small className="c-hint">(ว่าง = แอปเขียนชื่อ+เวลา Live ให้)</small></label>
              <textarea id="la-text" className="input c-text" value={text} maxLength={2000} placeholder="เช่น พรุ่งนี้ 6 โมงเช้า Live สด! กดติดตามไว้เลย" onChange={(e) => setText(e.target.value)} /></div>
            <div className="c-label">รูปโฆษณา</div>
            <div className="c-drop">
              {file ? (
                <span>📎 {file.name} <button type="button" className="btn" onClick={() => setFile(null)}>เอาออก</button></span>
              ) : (
                <span>ใช้รูปปกเพจ หรือ <button type="button" className="c-link" onClick={() => fileInput.current?.click()}>เลือกรูปเอง</button></span>
              )}
              <input ref={fileInput} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            </div>
            <div className="c-label">ปุ่ม &quot;ดูเพิ่มเติม&quot; พาไปหน้ากิจกรรม Live</div>
            {lives.length ? (
              <select className="input" value={liveId} onChange={(e) => setLiveId(e.target.value)} aria-label="Live ปลายทาง">
                {lives.map((l) => <option key={l.id} value={l.id}>Live &quot;{l.name}&quot; · {fmtTh(l.start_time)}</option>)}
              </select>
            ) : <div className="c-warn">ไม่มี Live ที่นัดไว้ (ที่ยังไม่เริ่ม) บนเพจ — นัด Live ใน Live Producer ก่อน แล้วเปิดกล่องนี้ใหม่</div>}
            {err && <div className="c-warn">{err}</div>}
            <div className="c-actions">
              <button className="btn primary" disabled={busy || !liveId} onClick={makeTeaser}>{busy ? "กำลังสร้าง…" : "สร้างโฆษณา (หยุดไว้)"}</button>
              <button className="btn" onClick={onClose} disabled={busy}>ปิด</button>
            </div>
          </>)) : (
            <LiveOnAirButton agent={agent} adsetId={info.adset_id!} pageId={pageChoice} onDone={(r) => setInfo({ ...info, ads: r.ads })} />
          )}
        </>)}
      </div>
    </div>
  );
}
