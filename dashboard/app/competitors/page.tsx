"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { adLibraryPageUrl, VIDEO_LINE_MAX } from "@/lib/competitorsTypes";
import type {
  Competitor, CompetitorAd, CompetitorCopy, CompetitorScan, CompetitorsClaudeView, CompetitorsState, CopyImage, CopySet, CopyVideo, KeywordHit, PageCandidate, SummaryRow,
} from "@/lib/competitorsTypes";
import { loadDraft, patchDraft } from "@/lib/draft";
import { fmtSize } from "@/components/InterestPicker";

/** วิเคราะห์คู่แข่ง — แอดที่คู่แข่งรันอยู่ในไทยจาก Meta Ad Library + Claude สรุป hook/offer + 3 มุมที่ยังไม่มีใครเล่น
 *  หน้าเว็บแค่แสดงและส่งคำสั่ง (ดึง/เทียบ/สรุปที่ server) · ไม่มีแอด/ดึงไม่ได้ = บอกตรง ๆ ไม่เดา · ไม่แตะอะไรใน Meta */

type Res = { ok: true; state: CompetitorsState } | { ok: false; error: string };

const PLATFORM: Record<string, string> = {
  FACEBOOK: "Facebook", INSTAGRAM: "Instagram", MESSENGER: "Messenger", AUDIENCE_NETWORK: "Audience Network", THREADS: "Threads", WHATSAPP: "WhatsApp",
};
const day = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
const when = (iso: string) => new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function call(url: string, body?: unknown): Promise<Res> {
  try {
    const r = await fetch(url, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return (await r.json()) as Res;
  } catch (e) {
    return { ok: false, error: `เชื่อมต่อแอปไม่ได้: ${(e as Error).message}` };
  }
}

/* ---------------- ค่าตั้ง: ธุรกิจ / คู่แข่ง / คำค้น ---------------- */

function Business({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <section className="card comp-card">
      <h3>ธุรกิจของเรา <span className="muted comp-small">(ให้ Claude ใช้คิดมุมที่ยังไม่มีใครเล่น)</span></h3>
      <textarea className="comp-text" rows={2} value={v} maxLength={1000} onChange={(e) => setV(e.target.value)} />
      {v.trim() !== value && (
        <div className="comp-row-end">
          <button className="btn" onClick={() => setV(value)}>ยกเลิก</button>
          <button className="btn primary" disabled={disabled || !v.trim()} onClick={() => onSave(v.trim())}>บันทึก</button>
        </div>
      )}
    </section>
  );
}

function AddCompetitor({ disabled, onAdd }: { disabled: boolean; onAdd: (c: Competitor) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [found, setFound] = useState<PageCandidate[] | null>(null);
  const find = async () => {
    setBusy(true); setErr(null); setFound(null);
    try {
      const r = (await (await fetch("/api/competitors/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
      })).json()) as { ok: true; pages: PageCandidate[] } | { ok: false; error: string };
      if (r.ok) setFound(r.pages); else setErr(r.error);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comp-add">
      <form className="comp-inline" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) find(); }}>
        <input className="comp-input" placeholder="＋ ชื่อเพจ, page_id หรือลิงก์ Ad Library" value={q} onChange={(e) => setQ(e.target.value)} disabled={busy} />
        <button className="btn" disabled={disabled || busy || q.trim().length < 2}>{busy ? "กำลังค้นใน Ad Library…" : "ค้นหา"}</button>
      </form>
      {err && <div className="comp-warn">⚠ {err}</div>}
      {found && (
        <div className="comp-found">
          {found.map((p) => (
            <div key={p.pageId} className="comp-hit">
              <span><b>{p.name}</b> <span className="muted">· page_id {p.pageId} · แอดรันอยู่ {p.ads}</span></span>
              <button className="btn comp-sm" disabled={disabled} onClick={() => { onAdd({ pageId: p.pageId, name: p.name }); setFound(null); setQ(""); }}>＋ เพิ่ม</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MAX_KEYWORDS = 8;   // ตรงกับ saveConfig ใน lib/competitors.ts

/** ✨ ให้ Claude คิดคำค้น — คำแนะนำ 8 คำ ติ๊กเลือกแล้วเพิ่ม (คำเดิมยังอยู่) */
function KeywordIdeasBox({ s, disabled, onAdd }: { s: CompetitorsState; disabled: boolean; onAdd: (k: string[]) => void }) {
  const ideas = s.keywordIdeas;
  const [pick, setPick] = useState<string[]>([]);
  useEffect(() => setPick([]), [ideas?.at]);
  const busy = s.running?.kind === "keywords";
  if (busy) return <div className="comp-busy">⏳ {s.running?.step} (ราว 20 วิ)</div>;
  if (s.keywordIdeasError) return <div className="comp-warn">⚠ Claude คิดคำค้นไม่ได้: {s.keywordIdeasError}</div>;
  if (!ideas?.items.length) return null;
  const have = new Set(s.keywords.map((k) => k.toLowerCase()));
  const room = MAX_KEYWORDS - s.keywords.length;
  const toggle = (k: string) => setPick((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  return (
    <div className="comp-kwi">
      <div className="comp-kwi-head">
        <b>✨ คำค้นที่ Claude แนะนำ</b>
        <span className="muted comp-small"> · เรียงจากเจาะจงที่สุด → กว้างสุด · {when(ideas.at)} · {ideas.model}</span>
      </div>
      {ideas.noise && <div className="muted comp-small">คำค้นเดิมจับเพจที่ไม่ใช่คู่แข่งมาด้วย: {ideas.noise}</div>}
      {ideas.items.map((it) => {
        const added = have.has(it.keyword.toLowerCase());
        const on = pick.includes(it.keyword);
        const full = !on && pick.length >= room;
        return (
          <label key={it.keyword} className={`comp-kwi-row${added ? " added" : ""}`}>
            <input type="checkbox" checked={added || on} disabled={disabled || added || full} onChange={() => toggle(it.keyword)} />
            <span><b>&quot;{it.keyword}&quot;</b>{added && <span className="pill ok comp-pill">เพิ่มแล้ว</span>}
              {it.why && <span className="comp-sample">{it.why}</span>}</span>
          </label>
        );
      })}
      <div className="comp-kwi-foot">
        <button className="btn primary comp-sm" disabled={disabled || !pick.length} onClick={() => { onAdd(pick); setPick([]); }}>
          ＋ เพิ่มคำที่เลือก{pick.length ? ` (${pick.length})` : ""}
        </button>
        <span className="muted comp-small">
          {room <= 0 ? `คำค้นเต็ม ${MAX_KEYWORDS} คำแล้ว — ลบคำเดิมก่อน` : `เพิ่มได้อีก ${room} คำ (สูงสุด ${MAX_KEYWORDS})`} · เพิ่มแล้วกด 🔍 หาคู่แข่งจากคำค้น
        </span>
      </div>
    </div>
  );
}

const MAX_COMPETITORS = 15;   // ตรงกับ saveConfig ใน lib/competitors.ts

/** แถวเพจที่เจอจากคำค้น — ติ๊กเลือกได้ · ป้าย/เหตุผลจาก Claude (ถ้าคัดแล้ว) */
function HitRow({ h, on, lock, onToggle }: { h: KeywordHit; on: boolean; lock: boolean; onToggle: () => void }) {
  return (
    <label className={`comp-kwi-row comp-hitrow${h.verdict === "no" ? " no" : ""}`}>
      <input type="checkbox" checked={on} disabled={lock} onChange={onToggle} />
      <span className="comp-hitrow-main">
        <b>{h.name}</b>
        {h.verdict === "yes" && <span className="pill ok comp-pill">✅ น่าจะคู่แข่ง</span>}
        {h.verdict === "no" && <span className="pill comp-pill">⚪ ไม่เกี่ยว</span>}
        <span className="muted comp-small"> · {h.ads} แอด · จาก &quot;{h.keyword}&quot;</span>
        {h.why && <span className="comp-sample comp-why">Claude: {h.why}</span>}
        {h.sample && <span className="comp-sample">{h.sample}</span>}
      </span>
      <a className="comp-small" href={adLibraryPageUrl(h.pageId)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>ดู ↗</a>
    </label>
  );
}

/** 🔍 หาคู่แข่งจากคำค้น — เพจที่เจอ (Claude คัดแล้ว: น่าจะคู่แข่งอยู่บน ติ๊กไว้ให้ · ไม่เกี่ยวพับไว้ท้าย) → ติ๊กแล้วเพิ่มทีเดียว */
function HitsBox({ s, disabled, onAdd }: { s: CompetitorsState; disabled: boolean; onAdd: (c: Competitor[]) => void }) {
  const room = MAX_COMPETITORS - s.competitors.length;
  const yes = s.hits.filter((h) => h.verdict === "yes");
  const unjudged = s.hits.filter((h) => !h.verdict);
  const no = s.hits.filter((h) => h.verdict === "no");
  const [pick, setPick] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  // คัดรอบใหม่ = ติ๊กเพจที่ Claude ว่าน่าจะคู่แข่งไว้ให้ (ไม่เกินที่ว่าง)
  useEffect(() => setPick(yes.slice(0, Math.max(0, room)).map((h) => h.pageId)), [s.hitsJudge?.at]);
  const busy = s.running?.kind === "find";
  const warn = s.keywordScans.filter((k) => k.error);
  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const live = pick.filter((id) => s.hits.some((h) => h.pageId === id));   // เพจที่ยังอยู่ในรายการ
  const row = (h: KeywordHit) => {
    const on = live.includes(h.pageId);
    return <HitRow key={h.pageId} h={h} on={on} lock={disabled || (!on && live.length >= room)} onToggle={() => toggle(h.pageId)} />;
  };
  const shown = all ? unjudged : unjudged.slice(0, Math.max(0, 8 - yes.length));
  const add = () => {
    const chosen = s.hits.filter((h) => live.includes(h.pageId)).map((h) => ({ pageId: h.pageId, name: h.name }));
    if (chosen.length) onAdd(chosen);
    setPick([]);
  };
  return (
    <>
      {busy && <div className="comp-busy">⏳ {s.running?.step} (ค้นราว 1–3 นาที แล้ว Claude คัดอีกราว 30 วิ)</div>}
      {warn.length > 0 && <div className="comp-warn">⚠ {warn.map((k) => `"${k.keyword}": ${k.error}`).join(" · ")}</div>}
      {s.hitsJudgeError && <div className="comp-warn">⚠ Claude คัดเพจไม่ได้: {s.hitsJudgeError} — รายการด้านล่างยังไม่ได้คัด ดูเองแล้วติ๊กได้</div>}
      {!busy && !s.hits.length && s.keywordScans.length > 0 && !warn.length && (
        <div className="muted comp-small comp-hits">ค้นรอบล่าสุดไม่เจอเพจใหม่ที่ยังไม่ได้เป็นคู่แข่ง — ลองกด ✨ ให้ Claude คิดคำค้นใหม่</div>
      )}
      {s.hits.length > 0 && (
        <div className="comp-kwi comp-hits">
          <div className="comp-kwi-head">
            <b>เจอจากคำค้นรอบล่าสุด — ยังไม่ได้เป็นคู่แข่ง ({s.hits.length})</b>
            {s.hitsJudge
              ? <span className="muted comp-small"> · Claude คัด: ✅ {yes.length} น่าจะคู่แข่ง · ⚪ {no.length} ไม่เกี่ยว{unjudged.length ? ` · ${unjudged.length} ยังไม่ได้คัด` : ""} · {when(s.hitsJudge.at)} · {s.hitsJudge.model}</span>
              : <span className="muted comp-small"> · ยังไม่ได้ให้ Claude คัด (กด 🔍 หาคู่แข่งจากคำค้น)</span>}
          </div>
          {s.keywordScans.length > 0 && <div className="muted comp-small">{s.keywordScans.map((k) => `"${k.keyword}" ~${k.total ?? "?"} แอด${k.loose ? " (หลวม)" : ""}`).join(" · ")}{s.keywordScans.some((k) => k.loose) && " · (หลวม) = วลีตรงตัวไม่เจอ เลยค้นแบบมีครบทุกคำ ผลปนมากกว่า"}</div>}
          {yes.map(row)}
          {shown.map(row)}
          {unjudged.length > shown.length && <button className="btn comp-sm comp-more" onClick={() => setAll(true)}>ดูทั้งหมด {unjudged.length} เพจ</button>}
          {all && unjudged.length > 8 && <button className="btn comp-sm comp-more" onClick={() => setAll(false)}>ย่อ</button>}
          {no.length > 0 && (
            <details className="comp-hits-no">
              <summary>⚪ ไม่เกี่ยว ({no.length} เพจ) — ถ้า Claude คัดผิด เปิดแล้วติ๊กเองได้</summary>
              {no.map(row)}
            </details>
          )}
          <div className="comp-kwi-foot">
            <button className="btn primary comp-sm" disabled={disabled || !live.length} onClick={add}>
              ＋ เพิ่มที่เลือกเป็นคู่แข่ง{live.length ? ` (${live.length})` : ""}
            </button>
            <span className="muted comp-small">
              {room <= 0 ? `คู่แข่งเต็ม ${MAX_COMPETITORS} เจ้าแล้ว — เอาเจ้าเดิมออกก่อน` : `เพิ่มได้อีก ${room} เจ้า (สูงสุด ${MAX_COMPETITORS})`} · ดึงแอดของคู่แข่งใหม่: กด 🔄 รีเฟรชข้อมูล
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function Setup({ s, disabled, save, onIdeas, onFind }: { s: CompetitorsState; disabled: boolean; save: (p: Partial<Pick<CompetitorsState, "competitors" | "keywords">>) => void; onIdeas: () => void; onFind: () => void }) {
  const [kw, setKw] = useState("");
  const has = new Set(s.competitors.map((c) => c.pageId));
  const remove = (c: Competitor) => {
    if (window.confirm(`เอา "${c.name}" ออกจากรายชื่อคู่แข่ง? (ผลสแกนของเจ้านี้จะหายไปด้วย)`))
      save({ competitors: s.competitors.filter((x) => x.pageId !== c.pageId) });
  };
  const add = (c: Competitor) => { if (!has.has(c.pageId)) save({ competitors: [...s.competitors, c] }); };
  return (
    <section className="card comp-card">
      <h3>คู่แข่ง {s.competitors.length} เจ้า</h3>
      <div className="comp-chips">
        {s.competitors.map((c) => (
          <span key={c.pageId} className="comp-chip" title={`page_id ${c.pageId}`}>
            {c.name}<button aria-label={`เอา ${c.name} ออก`} disabled={disabled} onClick={() => remove(c)}>✕</button>
          </span>
        ))}
        {!s.competitors.length && <span className="muted">ยังไม่มี — ค้นชื่อเพจด้านล่าง หรือกด 🔍 หาคู่แข่งจากคำค้น</span>}
      </div>
      <AddCompetitor disabled={disabled} onAdd={add} />

      <div className="comp-kw-title">
        <h3 className="comp-h3-gap">คำค้นหาผู้ลงโฆษณารายใหม่ <span className="muted comp-small">(ค้นวลีตรงตัวในข้อความแอด · ไม่เจอเลยค้นแบบมีครบทุกคำแทน)</span></h3>
        <span className="spacer" />
        <button className="btn comp-sm" disabled={!!s.running || disabled || !s.business.trim()} onClick={onIdeas}
          title={s.running ? `${s.running.step} — รอให้เสร็จก่อน` : !s.business.trim() ? "ใส่และบันทึก \"ธุรกิจของเรา\" ก่อน" : "Claude อ่านธุรกิจของเรา + คู่แข่ง + คำค้นเดิม แล้วเสนอ 8 คำ (เสียค่า Claude 1 ครั้ง)"}>
          {s.running?.kind === "keywords" ? "Claude กำลังคิด…" : s.keywordIdeas ? "✨ ให้ Claude คิดคำค้นใหม่" : "✨ ให้ Claude คิดคำค้น"}
        </button>
        <button className="btn primary comp-sm" disabled={!!s.running || disabled || !s.keywords.length} onClick={onFind}
          title={s.running ? `${s.running.step} — รอให้เสร็จก่อน` : !s.keywords.length ? "เพิ่มคำค้นก่อน (พิมพ์เอง หรือกด ✨ ให้ Claude คิดคำค้น)" : `ค้นทั้ง ${s.keywords.length} คำใน Ad Library (ราว 1–3 นาที) แล้ว Claude คัดเพจที่เจอ (เสียค่า Claude 1 ครั้ง) · ไม่สแกนแอดคู่แข่งเดิม`}>
          {s.running?.kind === "find" ? "กำลังหา…" : "🔍 หาคู่แข่งจากคำค้น"}
        </button>
      </div>
      <div className="comp-chips">
        {s.keywords.map((k) => (
          <span key={k} className="comp-chip">&quot;{k}&quot;<button aria-label={`ลบคำค้น ${k}`} disabled={disabled} onClick={() => save({ keywords: s.keywords.filter((x) => x !== k) })}>✕</button></span>
        ))}
        <form className="comp-inline" onSubmit={(e) => { e.preventDefault(); const k = kw.trim(); if (k) { save({ keywords: [...s.keywords, k] }); setKw(""); } }}>
          <input className="comp-input comp-input-sm" placeholder="＋ คำค้น" value={kw} onChange={(e) => setKw(e.target.value)} maxLength={60} />
          {kw.trim() && <button className="btn comp-sm" disabled={disabled}>เพิ่ม</button>}
        </form>
      </div>
      <KeywordIdeasBox s={s} disabled={disabled} onAdd={(k) => save({ keywords: [...s.keywords, ...k] })} />
      <HitsBox s={s} disabled={disabled} onAdd={(c) => save({ competitors: [...s.competitors, ...c.filter((x) => !has.has(x.pageId))] })} />
    </section>
  );
}

/* ---------------- แถบสแกน ---------------- */

function ScanBar({ s, claude, onScan, onSummary }: { s: CompetitorsState; claude: CompetitorsClaudeView | null; onScan: () => void; onSummary: () => void }) {
  const scans = s.competitors.map((c) => s.scans[c.pageId]).filter((x): x is CompetitorScan => !!x);
  const ads = scans.reduce((n, x) => n + x.ads.length, 0);
  const fresh = scans.reduce((n, x) => n + x.newIds.length, 0);
  const gone = scans.reduce((n, x) => n + x.gone, 0);
  const none = scans.filter((x) => x.status === "none").length;
  const bad = scans.filter((x) => x.status === "error").length;
  return (
    <section className="card comp-card comp-bar">
      <button className="btn primary" disabled={!!s.running} onClick={onScan}>{s.running?.kind === "scan" ? "กำลังสแกน…" : "🔄 สแกน Ad Library ตอนนี้"}</button>
      {s.running
        ? <span className="comp-busy">⏳ {s.running.step}</span>
        : s.lastScan
          ? <span>สแกนล่าสุด {when(s.lastScan.at)} · {scans.length} เจ้า · {ads} แอด</span>
          : <span className="muted">ยังไม่เคยสแกน — กดปุ่มเพื่อเปิด Ad Library ทีละเจ้า (ราว 15 วิ/เจ้า)</span>}
      {!s.running && fresh > 0 && <span className="pill ok">＋{fresh} แอดใหม่</span>}
      {!s.running && gone > 0 && <span className="pill bad">−{gone} หายไป</span>}
      {!s.running && none > 0 && <span className="pill warn">⚠ {none} เจ้าไม่มีแอดรันอยู่</span>}
      {!s.running && bad > 0 && <span className="pill bad">⚠ {bad} เจ้าดึงไม่ได้</span>}
      <span className="spacer" />
      <button className="btn" disabled={!!s.running} onClick={onSummary}>{s.running?.kind === "summary" ? "Claude กำลังสรุป…" : "✨ ให้ Claude สรุปใหม่"}</button>
      {s.lastScan?.error && <div className="comp-warn comp-full">⚠ {s.lastScan.error}</div>}
      {claude && (
        <div className="comp-full comp-claude-line">
          Claude: {claude.model} · {claude.using === "own" ? `คีย์ของฟังก์ชันนี้ …${claude.last4}` : claude.using === "agent" ? `คีย์ของ Agent Claude …${claude.last4}` : "ยังไม่มีคีย์"}
          {claude.check && !claude.check.ok && <span className="comp-claude-bad"> · ✕ ทดสอบล่าสุดไม่ผ่าน</span>}
          {" · "}<a href="/?tab=connect#competitors-claude">ตั้งค่าที่แท็บเชื่อมต่อ API</a>
        </div>
      )}
    </section>
  );
}

/* ---------------- สรุปจาก Claude ---------------- */

function Summary({ s }: { s: CompetitorsState }) {
  const rows = new Map<string, SummaryRow>((s.summary?.rows ?? []).map((r) => [r.pageId, r]));
  const anyScan = s.competitors.some((c) => s.scans[c.pageId]);
  if (!anyScan && !s.summary) return null;
  return (
    <section className="card comp-card">
      <h3>สรุปจาก Claude <span className="muted comp-small">
        {s.summary ? `อิงข้อความแอดจริงด้านล่างเท่านั้น · สรุปเมื่อ ${when(s.summary.at)}` : "ยังไม่มีผลสรุป"}
      </span></h3>
      {s.summaryError && <div className="comp-warn">⚠ Claude สรุปไม่ได้: {s.summaryError}</div>}
      <div className="comp-table-wrap">
        <table className="comp-table">
          <thead><tr><th>คู่แข่ง</th><th>แอดที่รัน</th><th>hook ที่ใช้ซ้ำ</th><th>offer</th><th>รันนานสุด</th></tr></thead>
          <tbody>
            {s.competitors.map((c) => {
              const x = s.scans[c.pageId];
              const r = rows.get(c.pageId);
              if (!x) return <tr key={c.pageId}><td className="comp-name">{c.name}</td><td colSpan={4} className="muted">ยังไม่ได้สแกน</td></tr>;
              if (x.status === "none") return <tr key={c.pageId}><td className="comp-name">{c.name}</td><td colSpan={4} className="comp-none">ไม่มีแอดที่รันอยู่ในไทย (เช็ก {when(x.at)}) — ไม่สรุป ไม่เดา</td></tr>;
              if (x.status === "error") return <tr key={c.pageId}><td className="comp-name">{c.name}</td><td colSpan={4} className="comp-bad">ดึงไม่ได้ — {x.error} · วางเองได้ที่ &quot;แอดรายเจ้า&quot;</td></tr>;
              return (
                <tr key={c.pageId}>
                  <td className="comp-name">{c.name}</td>
                  <td className="num" data-label="แอดที่รัน">{x.total ?? x.ads.length}{x.source === "paste" && <span className="muted comp-small"> (วางเอง)</span>}</td>
                  <td data-label="hook ที่ใช้ซ้ำ">{r ? r.hooks.map((h, i) => <div key={i}>{h}</div>) : <span className="muted">—</span>}</td>
                  <td data-label="offer">{r ? r.offer : <span className="muted">—</span>}</td>
                  <td data-label="รันนานสุด">{x.longest ? <>{day(x.longest.start)} <span className="muted">({x.longest.days} วัน)</span><div className="muted comp-small">{x.longest.text}</div></> : <span className="muted">ไม่รู้วันเริ่ม</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {s.summary?.note && <p className="comp-note">{s.summary.note}</p>}
      {s.summary && s.summary.angles.length > 0 && (
        <>
          <h3 className="comp-h3-gap">{s.summary.angles.length} มุมที่ยังไม่มีใครเล่น</h3>
          <div className="comp-angles">
            {s.summary.angles.map((a, i) => (
              <div key={i} className="comp-angle"><b>{"①②③④⑤"[i] ?? "•"} {a.title}</b><span className="muted comp-small">{a.why}</span></div>
            ))}
          </div>
        </>
      )}
      {s.summary && <div className="muted comp-small comp-model">สรุปโดย {s.summary.model} · hook/offer/มุม = Claude · รันนานสุด = แอปคำนวณจากวันเริ่มจริง</div>}
    </section>
  );
}

/* ---------------- ✨ ความสนใจ + คำโฆษณา 5 ชุด ---------------- */

const NUM = "①②③④⑤";
const copyText = (x: CopySet) => [x.primary, "", `พาดหัว: ${x.headline}`, `คำอธิบาย: ${x.description}`, `ปุ่ม: ${x.ctaLabel}`].join("\n");
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);

/** คัดลอกลงคลิปบอร์ด — เบราว์เซอร์ไม่ให้สิทธิ์ → วิธีเก่า (เลือกข้อความในช่องซ่อนแล้วสั่งคัดลอก) */
async function toClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    t.remove();
    return ok;
  }
}
const COPY_FAIL = "คัดลอกไม่ได้ — เบราว์เซอร์ไม่ให้สิทธิ์คลิปบอร์ด · เลือกข้อความแล้วกด Ctrl+C แทน";

/** ปุ่มคัดลอกข้อความ 1 ก้อน — จำสถานะ "คัดลอกแล้ว" / คัดลอกไม่ได้ ของตัวเอง */
function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(false);
  const copy = async () => {
    const ok = await toClipboard(text);
    setErr(!ok);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  return (
    <>
      <div><button className="btn comp-sm" disabled={!text} onClick={copy}>{copied ? "✓ คัดลอกแล้ว" : `📋 ${label}`}</button></div>
      {err && <div className="comp-warn">⚠ {COPY_FAIL}</div>}
    </>
  );
}
/** คัดลอก = prompt + "Avoid: …" (บางเครื่องมือไม่มีช่อง negative) */
const withAvoid = (prompt: string, avoid: string) => `${prompt}\n\nAvoid: ${avoid}`;

/** 🎬 คลิป 16 วิ = 2 ช็อต × 8 วิ · ช็อต 1 ใช้ภาพ 9:16 ของแท็บข้าง ๆ เป็นเฟรมแรก */
function VideoPrompt({ v, imageAvoid }: { v: CopyVideo; imageAvoid: string }) {
  return (
    <>
      {v.story && <div className="muted comp-small">เรื่อง: {v.story}</div>}
      {v.shots.map((sh, i) => {
        const len = [...sh.line].length, over = len > VIDEO_LINE_MAX;
        return (
          <div key={i} className="comp-shot">
            <div className="comp-shot-head">ช็อต {i + 1} <span className="comp-shot-time">{i * 8}–{i * 8 + 8} วิ</span> {sh.goal}</div>
            {sh.frame ? (
              <>
                <div className="muted comp-small">เฟรมแรก: สร้างภาพนี้ก่อน (คนเดิม ฉากเดิม) แล้วแนบตอนสร้างคลิป ↓</div>
                <div className="comp-img-prompt">{sh.frame}</div>
                <CopyBtn text={withAvoid(sh.frame, imageAvoid)} label="คัดลอก prompt ภาพเฟรมแรก" />
              </>
            ) : <div className="muted comp-small">เฟรมแรก: ใช้ภาพจากแท็บ &quot;9:16 Story&quot;</div>}
            <div className="comp-shot-line">“{sh.line}” <span className={over ? "comp-shot-over" : "muted"}>{over ? `${len}/${VIDEO_LINE_MAX} เกิน ${VIDEO_LINE_MAX} — ตัดคำก่อนใช้` : `${len}/${VIDEO_LINE_MAX} ตัวอักษร`}</span></div>
            <div className="comp-img-prompt">{sh.prompt}</div>
            {sh.caption && <div className="comp-shot-cap">ข้อความขึ้นจอ (ใส่เองใน CapCut): {sh.caption}</div>}
            <CopyBtn text={withAvoid(sh.prompt, v.avoid)} label={`คัดลอก prompt ช็อต ${i + 1}`} />
          </div>
        );
      })}
      <div className="comp-img-avoid">ห้ามมีในคลิป: {v.avoid}</div>
    </>
  );
}

/** 🎨 ภาพประกอบของชุดนี้ — สลับ 1:1 / 9:16 / 🎬 คลิป 16 วิ (แท็บคลิปขึ้นเมื่อกด 🎬 แล้ว) */
function ImagePrompt({ m, v, videos }: { m: CopyImage | null | undefined; v: CopyVideo | null | undefined; videos: boolean }) {
  const [size, setSize] = useState<"square" | "story" | "video">("square");
  const tab = size === "video" && !videos ? "square" : size;
  const prompt = m ? (tab === "square" ? m.square : m.story) : "";
  return (
    <div className="comp-img">
      <div className="comp-img-head">
        <b>{videos ? "🎨 ภาพและคลิป" : "🎨 ภาพประกอบ"}</b><span className="spacer" />
        {(m || videos) && (
          <span className="comp-seg">
            <button className={tab === "square" ? "on" : ""} onClick={() => setSize("square")}>1:1 Feed</button>
            <button className={tab === "story" ? "on" : ""} onClick={() => setSize("story")}>9:16 Story</button>
            {videos && <button className={tab === "video" ? "on" : ""} onClick={() => setSize("video")}>🎬 คลิป 16 วิ</button>}
          </span>
        )}
      </div>
      {tab === "video" ? (
        v ? <VideoPrompt v={v} imageAvoid={m?.avoid ?? ""} /> : <div className="muted comp-small">Claude ไม่ได้ส่ง prompt คลิปของชุดนี้มา — กด &quot;🎬 คิด prompt คลิปใหม่&quot; ด้านบน</div>
      ) : !m ? <div className="muted comp-small">Claude ไม่ได้ส่ง prompt ของชุดนี้มา — กด &quot;🎨 คิด prompt ภาพใหม่&quot; ด้านบน</div> : (
        <>
          {m.scene && <div className="muted comp-small">ฉาก: {m.scene}</div>}
          <div className="comp-img-prompt">{prompt}</div>
          <div className="comp-img-avoid">ห้ามมี: {m.avoid}</div>
          {(tab === "square" ? m.spaceSquare : m.spaceStory) && <div className="comp-img-space">วางพาดหัว: {tab === "square" ? m.spaceSquare : m.spaceStory}</div>}
          <CopyBtn text={withAvoid(prompt, m.avoid)} label={`คัดลอก prompt ${tab === "square" ? "1:1" : "9:16"}`} />
        </>
      )}
    </div>
  );
}

/** ร่างในฟอร์มสร้างโฆษณาที่จะถูกแทนที่ (null = ฟอร์มว่าง เขียนได้เลย) */
function draftInUse(): { text: string; interests: number } | null {
  const d = loadDraft();
  const text = (d?.text ?? "").trim() || (d?.texts ?? []).map((t) => t.trim()).find(Boolean) || "";
  const interests = d?.interestsBy?.claude?.length ?? 0;
  return text || interests ? { text, interests } : null;
}

/** "ใช้ชุดนี้" → เติมลงร่างของฟอร์มสร้างโฆษณา (Claude · ยิงข้อความ) แล้วเปิดแท็บนั้น · ไม่ยิง Meta */
function applySet(x: CopySet, c: CompetitorCopy): boolean {
  const d = loadDraft();
  const interests = c.interests.map(({ id, name, size_lower, size_upper, th_lower, th_upper }) => ({ id, name, size_lower, size_upper, th_lower, th_upper }));
  const ok = patchDraft({
    agent: "claude", kind: "MESSENGER", text: x.primary, texts: [x.primary], titles: x.headline ? [x.headline] : [],
    title: x.headline, desc: x.description,
    interestsBy: { manus: [], chatgpt: [], ...(d?.interestsBy ?? {}), claude: interests },
    aiRuns: { manus: null, chatgpt: null, ...(d?.aiRuns ?? {}), claude: null },
  });
  if (ok) window.location.href = "/?tab=create";
  return ok;
}

function CopyCard({ x, label, c }: { x: CopySet; label: string; c: CompetitorCopy }) {
  const [copied, setCopied] = useState(false);
  const [ask, setAsk] = useState<{ text: string; interests: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const copy = async () => {
    setErr(null);
    if (await toClipboard(copyText(x))) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
    else setErr(COPY_FAIL);
  };
  const use = (force: boolean) => {
    setErr(null);
    const old = force ? null : draftInUse();
    if (old) { setAsk(old); return; }
    if (!applySet(x, c)) setErr("เขียนร่างลงเบราว์เซอร์ไม่ได้ — คัดลอกไปวางเองแทน");
  };
  return (
    <div className="comp-copy">
      <span className={`comp-copy-tag${x.kind === "fix" ? " fix" : ""}`}>{label}</span>
      <div className="comp-copy-f">ข้อความหลัก</div>
      <div className="comp-copy-primary">{x.primary}</div>
      {x.headline && <><div className="comp-copy-f">พาดหัว</div><b>{x.headline}</b></>}
      {x.description && <><div className="comp-copy-f">คำอธิบายสั้น</div><div>{x.description}</div></>}
      <div className="comp-copy-cta"><span className="comp-copy-f">ปุ่ม</span><span className="comp-copy-btn">{x.ctaLabel}</span></div>
      {x.why && <div className="muted comp-small">ทำไม: {x.why}</div>}
      {c.imagesAt && <ImagePrompt m={x.image} v={x.video} videos={!!c.videosAt} />}
      {ask ? (
        <div className="c-confirm comp-copy-ask">
          <b>ฟอร์มสร้างโฆษณามีร่างค้างอยู่</b>
          {ask.text && <>ข้อความ &quot;{clip(ask.text, 60)}&quot;</>}{ask.text && ask.interests > 0 && " · "}{ask.interests > 0 && `ความสนใจของ Claude ${ask.interests} รายการ`}
          <div>ชุดนี้จะแทนที่ข้อความหลัก พาดหัว คำอธิบาย และความสนใจของ Claude (รูป งบ ชื่อแคมเปญ คงเดิม)</div>
          <div className="comp-copy-acts">
            <button className="btn comp-sm primary" onClick={() => use(true)}>แทนที่แล้วไปแท็บสร้างโฆษณา</button>
            <button className="btn comp-sm" onClick={() => setAsk(null)}>ยกเลิก</button>
          </div>
        </div>
      ) : (
        <div className="comp-copy-acts">
          <button className="btn comp-sm" onClick={copy}>{copied ? "✓ คัดลอกแล้ว" : "📋 คัดลอก"}</button>
          <button className="btn comp-sm primary" onClick={() => use(false)}>ใช้ชุดนี้ในแท็บสร้างโฆษณา →</button>
        </div>
      )}
      {err && <div className="comp-warn">⚠ {err}</div>}
    </div>
  );
}

function CopyIdeas({ s, onRun, onImages, onVideos }: { s: CompetitorsState; onRun: () => void; onImages: () => void; onVideos: () => void }) {
  const c = s.copy;
  const hasAds = s.competitors.some((x) => s.scans[x.pageId]?.status === "ok");
  if (!hasAds && !c) return null;
  const busy = s.running?.kind === "copy";
  const imgBusy = s.running?.kind === "image";
  const vidBusy = s.running?.kind === "video";
  let n = 0;
  return (
    <section className="card comp-card">
      <div className="comp-copy-head">
        <h3>ความสนใจ + คำโฆษณาจาก Claude <span className="muted comp-small">
          {c ? `อิงแอดคู่แข่ง ${c.adsUsed} แอด + "ธุรกิจของเรา" · คิดเมื่อ ${when(c.at)} · ${c.model}` : "ยังไม่เคยคิด"}
        </span></h3>
        <span className="spacer" />
        <button className="btn primary" disabled={!!s.running || !hasAds} onClick={onRun}>
          {busy ? "Claude กำลังคิด…" : c ? "✨ คิดใหม่" : "✨ คิดความสนใจ + คำโฆษณา 5 ชุด"}
        </button>
      </div>
      <p className="muted comp-small comp-copy-cost">
        กดแล้วเสียค่า API ตามรุ่นที่เลือก · ค้นคลังความสนใจของ Meta แบบอ่านอย่างเดียว ไม่สร้างอะไรบน Meta
        {!s.summary && " · ยังไม่มีผลสรุป → Claude จะหามุมใหม่เองจากแอด"}
      </p>
      {busy && <div className="comp-busy">⏳ {s.running?.step} (ราว 1 นาที)</div>}
      {s.copyError && !busy && <div className="comp-warn">⚠ Claude คิดไม่ได้: {s.copyError}</div>}
      {c && (
        <>
          <div className="comp-copy-sub"><b>ความสนใจในคลังของ Meta</b> <span className="muted comp-small">(ค้นจริง · ใช้ตั้งกลุ่มเป้าหมายได้ทันที)</span></div>
          {c.interests.length > 0 && (
            <div className="comp-chips">
              {c.interests.map((x) => (
                <span key={x.id} className="comp-chip comp-int">{x.name}{fmtSize(x.th_lower, x.th_upper) && <span className="muted"> · ไทย {fmtSize(x.th_lower, x.th_upper)}</span>}</span>
              ))}
            </div>
          )}
          {c.reach && <div className="comp-reach">รวมคนไทยที่สนใจอย่างน้อย 1 อย่าง {fmtSize(c.reach.lower, c.reach.upper)}</div>}
          {c.searchError && <div className="comp-warn">⚠ {c.searchError}</div>}
          {(c.why || c.missed.length > 0) && (
            <div className="muted comp-small comp-copy-why">
              {c.why && <>ทำไม: {c.why}</>}{c.why && c.missed.length > 0 && " · "}
              {c.missed.length > 0 && <>ไม่เจอในคลัง: {c.missed.map((m) => `"${m}"`).join(", ")}</>}
            </div>
          )}
          <div className="comp-copy-head comp-h3-gap">
            <h3>คำโฆษณา {c.sets.length} ชุด <span className="muted comp-small">· น้ำเสียงกันเองสุภาพ · ไม่มีราคา/คำอวดที่พิสูจน์ไม่ได้ · ตรวจก่อนใช้ทุกครั้ง</span></h3>
            <span className="spacer" />
            <button className="btn primary" disabled={!!s.running || !c.sets.length} onClick={onImages}>
              {imgBusy ? "Claude กำลังคิดภาพ…" : c.imagesAt ? "🎨 คิด prompt ภาพใหม่" : "🎨 คิด prompt ภาพให้ 5 ชุด"}
            </button>
            <button className="btn primary" disabled={!!s.running || !c.imagesAt} onClick={onVideos}
              title={c.imagesAt ? undefined : "กด 🎨 ก่อน — ช็อต 1 ใช้ภาพ 9:16 นั้นเป็นเฟรมแรก"}>
              {vidBusy ? "Claude กำลังคิดคลิป…" : c.videosAt ? "🎬 คิด prompt คลิปใหม่" : "🎬 คิด prompt คลิป 16 วิ ให้ 5 ชุด"}
            </button>
          </div>
          <p className="muted comp-small comp-copy-cost">
            prompt ภาษาอังกฤษ ใช้ได้กับ ChatGPT / Gemini (Nano Banana) / Midjourney · ภาพถ่ายสมจริง ไม่มีตัวหนังสือ (ใส่พาดหัวเองทีหลัง)
            · เสียค่า Claude 1 ครั้ง แอปไม่สร้างภาพเอง{c.imagesAt && ` · คิดเมื่อ ${when(c.imagesAt)} · ${c.imagesModel ?? ""}`}
          </p>
          {imgBusy && <div className="comp-busy">⏳ {s.running?.step} (ราว 1 นาที)</div>}
          {c.imagesError && !imgBusy && <div className="comp-warn">⚠ Claude คิด prompt ภาพไม่ได้: {c.imagesError}</div>}
          <p className="muted comp-small comp-copy-cost">
            🎬 คลิป 9:16 ยาว 16 วิ = 2 ช็อต × 8 วิ ไปต่อกันใน CapCut · คนในภาพพูดไทยเอง · prompt ชุดเดียวใช้ได้ทั้ง Veo 3.1 และ Omni 1.2 (Google Flow)
            · ไม่มีตัวหนังสือในคลิป · เสียค่า Claude 1 ครั้ง แอปไม่สร้างคลิปเอง
            {c.imagesAt ? (c.videosAt ? ` · คิดเมื่อ ${when(c.videosAt)} · ${c.videosModel ?? ""} · ดูในแท็บ "🎬 คลิป 16 วิ" ของแต่ละการ์ด` : "") : " · กด 🎨 ก่อน (ช็อต 1 ใช้ภาพ 9:16 เป็นเฟรมแรก)"}
          </p>
          {vidBusy && <div className="comp-busy">⏳ {s.running?.step} (ราว 1–2 นาที)</div>}
          {c.videosError && !vidBusy && <div className="comp-warn">⚠ Claude คิด prompt คลิปไม่ได้: {c.videosError}</div>}
          <div className="comp-copy-grid">
            {c.sets.map((x, i) => (
              <CopyCard key={`${c.at}-${i}`} x={x} c={c}
                label={x.kind === "fix" ? `แก้จุดอ่อนคู่แข่ง · ${x.angle}` : `มุมใหม่ ${NUM[n++] ?? "•"} ${x.angle}`} />
            ))}
          </div>
          <div className="muted comp-small comp-model">
            ใช้ชุดนี้ → เปิดแท็บ &quot;＋ สร้างโฆษณา&quot; (Claude · ยิงข้อความ) เติมข้อความหลัก + พาดหัว + คำอธิบาย + ความสนใจด้านบนลงฟอร์ม
            · ชนิดยิงข้อความใช้ปุ่ม &quot;ส่งข้อความ&quot; เสมอ · พาดหัวขึ้นในฟอร์มเมื่อเปิดชิ้นงานไดนามิก · ยังไม่ยิง Meta ต้องกดสร้างเองตามปกติ
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------- แอดรายเจ้า + ช่องวางเอง ---------------- */

function Ad({ a, isNew }: { a: CompetitorAd; isNew: boolean }) {
  const [more, setMore] = useState(false);
  const long = a.body.length > 420;
  const plats = a.platforms.map((p) => PLATFORM[p] ?? p).join(", ");
  return (
    <div className="comp-ad">
      <div className="comp-ad-meta">
        {a.start ? `เริ่มรัน ${day(a.start)}` : "ไม่รู้วันเริ่ม"}
        {plats && ` · ${plats}`}{a.cta && ` · ปุ่ม "${a.cta}"`}{a.copies > 1 && ` · ใช้ชิ้นงานนี้ ${a.copies} แอด`}
        {isNew && <span className="pill ok comp-pill">ใหม่</span>}
        <span className="spacer" /><span className="muted">ID {a.id}</span>
      </div>
      {a.title && <b className="comp-ad-title">{a.title}</b>}
      <div className="comp-ad-body">{a.body ? (more || !long ? a.body : a.body.slice(0, 420) + "…") : <span className="muted">(แอดนี้ไม่มีข้อความ — เป็นภาพ/วิดีโออย่างเดียว)</span>}</div>
      {long && <button className="comp-link" onClick={() => setMore(!more)}>{more ? "ย่อ" : "อ่านต่อ"}</button>}
    </div>
  );
}

function Paste({ c, disabled, onDone }: { c: Competitor; disabled: boolean; onDone: (s: CompetitorsState) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setErr(null);
    const r = await call("/api/competitors/paste", { pageId: c.pageId, text });
    setBusy(false);
    if (r.ok) { setText(""); onDone(r.state); } else setErr(r.error);
  };
  return (
    <div className="comp-paste">
      <div className="comp-small">วางเอง: <a href={adLibraryPageUrl(c.pageId)} target="_blank" rel="noreferrer">เปิดหน้า Ad Library ของเจ้านี้ ↗</a> → กด Ctrl+A, Ctrl+C → วางที่นี่ (ภาษาไทยหรืออังกฤษก็ได้)</div>
      <textarea className="comp-text" rows={3} placeholder="วางข้อความทั้งหน้าจาก Ad Library" value={text} onChange={(e) => setText(e.target.value)} />
      {err && <div className="comp-warn">⚠ {err}</div>}
      <button className="btn comp-sm" disabled={disabled || busy || text.trim().length < 20} onClick={send}>{busy ? "กำลังแยกแอด…" : "ใช้ข้อความนี้"}</button>
    </div>
  );
}

function PerCompetitor({ s, disabled, onState }: { s: CompetitorsState; disabled: boolean; onState: (s: CompetitorsState) => void }) {
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  if (!s.competitors.length) return null;
  return (
    <section className="card comp-card">
      <h3>แอดรายเจ้า</h3>
      {s.competitors.map((c) => {
        const x = s.scans[c.pageId];
        const fresh = new Set(x?.newIds ?? []);
        const showPaste = x?.status === "error" || pasteFor === c.pageId;
        return (
          <details key={c.pageId} className="comp-each" open={x?.status === "error" || undefined}>
            <summary>
              <b>{c.name}</b>{" "}
              <span className="muted comp-small">
                · {!x ? "ยังไม่ได้สแกน" : x.status === "none" ? "ไม่มีแอดที่รันอยู่" : x.status === "error" ? "" : `${x.ads.length} แอด${x.total && x.total > x.ads.length ? ` (จาก ~${x.total})` : ""}`}
                {x?.source === "paste" && " · จากข้อความที่วางเอง"}
                {x && x.newIds.length > 0 && ` · ใหม่ ${x.newIds.length}`}{x && x.gone > 0 && ` · หายไป ${x.gone}`}
              </span>
              {x?.status === "error" && <span className="pill warn comp-pill">⚠ ดึงอัตโนมัติไม่ได้ — {x.error}</span>}
            </summary>
            <div className="comp-each-tools comp-small">
              <a href={adLibraryPageUrl(c.pageId)} target="_blank" rel="noreferrer">เปิดใน Ad Library ↗</a>
              {x?.status !== "error" && <button className="comp-link" onClick={() => setPasteFor(pasteFor === c.pageId ? null : c.pageId)}>{pasteFor === c.pageId ? "ปิดช่องวางเอง" : "วางข้อความเองแทน"}</button>}
              <span className="muted">page_id {c.pageId}</span>
            </div>
            {showPaste && <Paste c={c} disabled={disabled} onDone={(st) => { setPasteFor(null); onState(st); }} />}
            {x?.ads.map((a) => <Ad key={a.id} a={a} isNew={fresh.has(a.id)} />)}
          </details>
        );
      })}
    </section>
  );
}

/* ---------------- หัวหน้า: 🔄 รีเฟรช + 🗑 ล้างข้อมูล ---------------- */

/** มีผลลัพธ์อะไรค้างอยู่บ้าง — ใช้ทั้งเปิด/ปิดปุ่มล้าง และบอกในกล่องยืนยัน */
function resultsOf(s: CompetitorsState) {
  const scans = Object.values(s.scans);
  const parts = [
    scans.length ? `ผลสแกนแอด ${scans.length} เจ้า (${scans.reduce((n, x) => n + x.ads.length, 0)} แอด · รวมที่วางเอง)` : "",
    s.hits.length || s.keywordScans.length ? `ผลค้นคำค้น (${s.hits.length} เพจที่ยังไม่ได้เป็นคู่แข่ง)` : "",
    s.summary || s.summaryError ? "สรุปจาก Claude" : "",
    s.keywordIdeas || s.keywordIdeasError ? "คำค้นที่ Claude แนะนำ" : "",
    s.copy || s.copyError ? `ความสนใจ + คำโฆษณา${s.copy?.sets.length ? ` ${s.copy.sets.length} ชุด` : ""}${s.copy?.imagesAt ? " + prompt ภาพ" : ""}${s.copy?.videosAt ? " + prompt คลิป" : ""}` : "",
    s.lastScan && !scans.length ? "เวลาสแกนล่าสุด" : "",
  ];
  return parts.filter(Boolean);
}

function TopTools({ s, saving, onRefresh, onClear }: { s: CompetitorsState | null; saving: boolean; onRefresh: () => void; onClear: () => Promise<boolean> }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = s ? resultsOf(s) : [];
  const off = !s || !!s.running || saving;
  const why = s?.running ? `${s.running.step} — รอให้เสร็จก่อน` : undefined;
  const clear = async () => {
    setBusy(true);
    const ok = await onClear();
    setBusy(false);
    if (ok) setAsk(false);
  };
  return (
    <>
      <button className="btn" disabled={off || (!s?.competitors.length && !s?.keywords.length)} onClick={onRefresh}
        title={why ?? "สแกน Ad Library ใหม่ทุกเจ้า + ค้นคำค้นใหม่ แล้วให้ Claude สรุปใหม่ (เสียค่า Claude 1 ครั้ง)"}>
        {s?.running?.kind === "scan" ? "⏳ กำลังรีเฟรช…" : "🔄 รีเฟรชข้อมูล"}
      </button>
      <button className="btn danger" disabled={off || !items.length} onClick={() => setAsk(true)}
        title={why ?? (items.length ? "ล้างผลลัพธ์ทั้งหมด · เก็บธุรกิจ คู่แข่ง คำค้นไว้" : "ยังไม่มีผลลัพธ์ให้ล้าง")}>
        🗑 ล้างข้อมูล
      </button>
      {ask && s && createPortal(
        <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) setAsk(false); }}>
          <div className="card modal comp-clear" role="dialog" aria-modal="true" aria-label="ล้างข้อมูล">
            <div className="modal-h">
              <h3>🗑 ล้างข้อมูลหน้าวิเคราะห์คู่แข่ง?</h3>
              <button className="btn" onClick={() => setAsk(false)} disabled={busy} aria-label="ปิด">✕</button>
            </div>
            <div className="comp-clear-list">
              <b>จะลบ</b>
              <ul>{items.map((t) => <li key={t}>{t}</li>)}</ul>
              <b>เก็บไว้เหมือนเดิม</b>
              <ul>
                <li>ธุรกิจของเรา</li>
                <li>รายชื่อคู่แข่ง {s.competitors.length} เจ้า</li>
                <li>คำค้น {s.keywords.length} คำ</li>
              </ul>
            </div>
            <div className="comp-warn">⚠ ล้างแล้วกู้คืนไม่ได้ — ต้องกด 🔄 รีเฟรชข้อมูล และกด ✨ คิดคำโฆษณาใหม่ (เสียค่า Claude อีกครั้ง)</div>
            <div className="comp-clear-btns">
              <button className="btn" onClick={() => setAsk(false)} disabled={busy}>ยกเลิก</button>
              <button className="btn primary comp-clear-go" onClick={clear} disabled={busy}>{busy ? "กำลังล้าง…" : "ยืนยัน ล้างข้อมูล"}</button>
            </div>
          </div>
        </div>,
        document.body,   // แถบหัว (sticky + backdrop-filter) ตัดกล่องที่อยู่ข้างใน → วาดที่ body แทน
      )}
    </>
  );
}

/* ---------------- หน้า ---------------- */

export default function CompetitorsPage() {
  const [s, setS] = useState<CompetitorsState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [claude, setClaude] = useState<CompetitorsClaudeView | null>(null);

  const load = useCallback(async () => {
    const r = await call("/api/competitors");
    if (r.ok) setS(r.state); else setErr(r.error);
  }, []);
  useEffect(() => { load(); }, [load]);
  // คีย์/รุ่น Claude ที่ปุ่ม ✨ จะใช้ (แก้ที่การ์ดในแท็บเชื่อมต่อ API)
  useEffect(() => {
    fetch("/api/competitors/claude", { cache: "no-store" }).then((r) => r.json()).then((r) => { if (r.ok) setClaude(r.claude); }).catch(() => {});
  }, []);
  // ระหว่างสแกน/สรุป ถามความคืบหน้าทุก 3 วิ
  const running = !!s?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const act = async (url: string, body?: unknown) => {
    setErr(null);
    setSaving(true);
    const r = await call(url, body ?? {});
    setSaving(false);
    if (r.ok) setS(r.state); else setErr(r.error);
    return r.ok;
  };

  return (
    <>
      <header className="topbar comp-top">
        <div className="wrap">
          <div className="logo">🔍</div>
          <div className="brand">
            <h1>วิเคราะห์คู่แข่ง</h1>
            <p>ดึงจาก Meta Ad Library (ไทย · แอดที่รันอยู่) · ไม่ล็อกอิน Facebook · ไม่แตะอะไรในบัญชีโฆษณา</p>
          </div>
          <span className="spacer" />
          <div className="comp-top-tools">
            <TopTools s={s} saving={saving} onRefresh={() => act("/api/competitors/scan")} onClear={() => act("/api/competitors/clear")} />
            <a className="btn" href="/">กลับ Ads Control</a>
          </div>
        </div>
      </header>
      <main className="wrap comp-main">
        {err && <div className="banner">⚠ {err}</div>}
        {!s && !err && <div className="empty">กำลังโหลด…</div>}
        {s && (
          <>
            <Business value={s.business} disabled={saving} onSave={(v) => act("/api/competitors", { business: v })} />
            <Setup s={s} disabled={saving || s.running?.kind === "scan" || s.running?.kind === "find"} save={(p) => act("/api/competitors", p)} onIdeas={() => act("/api/competitors/keywords")} onFind={() => act("/api/competitors/find")} />
            <ScanBar s={s} claude={claude} onScan={() => act("/api/competitors/scan")} onSummary={() => act("/api/competitors/summary")} />
            <Summary s={s} />
            <CopyIdeas s={s} onRun={() => act("/api/competitors/copy")} onImages={() => act("/api/competitors/images")} onVideos={() => act("/api/competitors/videos")} />
            <PerCompetitor s={s} disabled={saving || s.running?.kind === "scan"} onState={setS} />
          </>
        )}
      </main>
    </>
  );
}
