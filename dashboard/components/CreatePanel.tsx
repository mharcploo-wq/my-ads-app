"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AgentId = "claude" | "manus" | "chatgpt";
type Kind = "MESSENGER" | "WEBSITE";

interface CheckItem { key: string; label: string; ok: boolean; detail: string }
interface AudienceOptions {
  min_age: number; max_age_min: number; default_age: number;
  languages: { key: string; label: string }[]; default_languages: string[]; fixed: string;
}
interface AgentStatus {
  agent: AgentId; prefix: string; ready: boolean; configured?: boolean; quota_full?: boolean; reason: string; checks: CheckItem[];
  max_daily_budget_thb: number; max_campaigns_per_day: number; campaigns_today: number | null;
  page_name: string | null; page_cover: string | null; audience?: AudienceOptions;
}
interface CreateResult {
  success: boolean; steps: CheckItem[]; campaign_name?: string; ads_manager_url?: string; dashboard_updated?: boolean;
}

const AGENTS: { id: AgentId; label: string; color: string; prefix: string }[] = [
  { id: "claude", label: "Claude", color: "var(--series-1)", prefix: "CLD-" },
  { id: "manus", label: "Manus", color: "var(--series-2)", prefix: "MANUS-" },
  { id: "chatgpt", label: "ChatGPT", color: "var(--series-3)", prefix: "GPT-" },
];
const KINDS: { id: Kind; icon: string; label: string; hint: string; cta: string }[] = [
  { id: "MESSENGER", icon: "💬", label: "ยิงข้อความ", hint: "คนกดปุ่ม \"ส่งข้อความ\" ทักแชทเพจ", cta: "ส่งข้อความ" },
  { id: "WEBSITE", icon: "🔗", label: "พาเข้าเว็บไซต์", hint: "คนกดปุ่ม \"ดูเพิ่มเติม\" ไปหน้าเว็บ", cta: "ดูเพิ่มเติม" },
];

/** วันเวลาไทย: "YYYY-MM-DD" + "HH:MM" → เวลาจริง (ms) */
const thMs = (d: string, t: string) => Date.parse(`${d}T${t || "00:00"}:00+07:00`);
const thDate = (offsetDays: number) => new Date(Date.now() + 7 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const fmtTh = (d: string, t: string) => { const [y, m, dd] = d.split("-"); return `${dd}/${m}/${y} ${t}`; };

export default function CreatePanel({ onCreated }: { onCreated: () => void }) {
  const [status, setStatus] = useState<AgentStatus[] | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentId>("claude");
  const [kind, setKind] = useState<Kind>("MESSENGER");
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("300");
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  // กำหนดเวลาเผยแพร่ (เวลาไทย)
  const [startMode, setStartMode] = useState<"now" | "set">("now");
  const [startDate, setStartDate] = useState(() => thDate(1));
  const [startTime, setStartTime] = useState("08:00");
  const [hasEnd, setHasEnd] = useState(false);
  const [endDate, setEndDate] = useState(() => thDate(8));
  const [endTime, setEndTime] = useState("23:59");
  // กลุ่มเป้าหมาย — null = ยังไม่แตะ ใช้ค่าเริ่มต้นจาก server.py
  const [ageMin, setAgeMin] = useState<number | null>(null);
  const [langs, setLangs] = useState<string[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    setStatusErr(null);
    try {
      const r = await fetch("/api/agents", { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      const list = j.agents as AgentStatus[];
      setStatus(list);
      const cur = list.find((a) => a.agent === agent);
      if (!cur?.configured) {
        const first = list.find((a) => a.ready) ?? list.find((a) => a.configured);
        if (first) setAgent(first.agent);
      }
    } catch (e) {
      setStatusErr((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (!file) { setFilePreview(null); return; }
    const u = URL.createObjectURL(file);
    setFilePreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const cur = status?.find((a) => a.agent === agent) ?? null;
  const kindInfo = KINDS.find((k) => k.id === kind)!;
  const maxBudget = cur?.max_daily_budget_thb || 1000;
  const left = cur && cur.campaigns_today != null ? Math.max(0, cur.max_campaigns_per_day - cur.campaigns_today) : null;
  const budgetNum = Number(budget);
  const previewImage = filePreview || imageUrl.trim() || cur?.page_cover || null;
  const audOpt = status?.find((a) => a.audience)?.audience ?? null;
  const age = ageMin ?? audOpt?.default_age ?? null;
  const pickedLangs = langs ?? audOpt?.default_languages ?? [];
  const ageChoices = audOpt ? Array.from({ length: audOpt.max_age_min - audOpt.min_age + 1 }, (_, i) => audOpt.min_age + i) : [];
  function toggleLang(key: string) {
    setLangs(pickedLangs.includes(key) ? pickedLangs.filter((k) => k !== key) : [...pickedLangs, key]);
  }
  const imageSource = file ? "ไฟล์จากเครื่อง" : imageUrl.trim() ? "ลิงก์รูป" : "รูปปกเพจ (ค่าเริ่มต้น)";

  const sched = useMemo(() => {
    const start = startMode === "set" ? thMs(startDate, startTime) : null;
    const end = hasEnd ? thMs(endDate, endTime) : null;
    let error: string | null = null;
    if (start !== null && (Number.isNaN(start) || !startDate)) error = "ใส่วันเวลาเริ่มให้ครบ";
    else if (end !== null && (Number.isNaN(end) || !endDate)) error = "ใส่วันสิ้นสุดให้ครบ";
    else if (start !== null && start < Date.now() - 5 * 60_000) error = "วันเวลาเริ่มย้อนอดีตไม่ได้";
    else if (end !== null && end < (start ?? Date.now()) + 24 * 3600_000) error = "วันสิ้นสุดต้องหลังวันเริ่มอย่างน้อย 1 วัน";
    const days = end !== null && !error ? Math.ceil((end - (start ?? Date.now())) / 86400_000) : null;
    const label = `${start !== null ? `เริ่ม ${fmtTh(startDate, startTime)}` : "เริ่มทันทีเมื่อกดเปิด"} → ${end !== null ? fmtTh(endDate, endTime) : "ไม่มีวันสิ้นสุด"}`;
    return {
      error, days, label,
      start_time: start !== null ? `${startDate}T${startTime}` : "",
      end_time: end !== null ? `${endDate}T${endTime}` : "",
    };
  }, [startMode, startDate, startTime, hasEnd, endDate, endTime]);

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!cur?.configured) p.push("ผู้สร้างที่เลือกยังไม่ได้ตั้งค่า");
    if (!name.trim()) p.push("ใส่ชื่อแคมเปญ");
    if (!Number.isInteger(budgetNum) || budgetNum <= 0) p.push("ใส่งบต่อวันเป็นตัวเลขเต็ม");
    else if (budgetNum > maxBudget) p.push(`งบเกินเพดาน ${maxBudget.toLocaleString()} บาท/วัน`);
    if (!text.trim()) p.push("ใส่ข้อความโฆษณา");
    if (kind === "WEBSITE" && !/^https?:\/\//.test(link.trim())) p.push("ใส่ลิงก์เว็บไซต์ (ขึ้นต้น https://)");
    if (left === 0) p.push("วันนี้สร้างครบโควตาแล้ว");
    if (sched.error) p.push(sched.error);
    if (audOpt && pickedLangs.length === 0) p.push("เลือกภาษาอย่างน้อย 1 ภาษา");
    return p;
  }, [cur, name, budgetNum, maxBudget, text, kind, link, left, sched.error, audOpt, pickedLangs.length]);

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    if (!f.type.startsWith("image/")) { setSubmitErr("ไฟล์ที่เลือกไม่ใช่รูป"); return; }
    setSubmitErr(null);
    setFile(f);
    setImageUrl("");
  }

  async function submit() {
    if (problems.length || busy) return;
    setBusy(true); setResult(null); setSubmitErr(null);
    const fd = new FormData();
    fd.set("agent", agent); fd.set("kind", kind); fd.set("name", name.trim());
    fd.set("daily_budget_thb", String(budgetNum)); fd.set("text", text.trim());
    if (kind === "WEBSITE") fd.set("link_url", link.trim());
    if (sched.start_time) fd.set("start_time", sched.start_time);
    if (sched.end_time) fd.set("end_time", sched.end_time);
    if (age != null) fd.set("age_min", String(age));
    pickedLangs.forEach((k) => fd.append("languages", k));
    if (file) fd.set("image", file); else if (imageUrl.trim()) fd.set("image_url", imageUrl.trim());
    try {
      const r = await fetch("/api/create", { method: "POST", body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setResult(j.result as CreateResult);
      if (j.result.success) onCreated();
      loadStatus();
    } catch (e) {
      setSubmitErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResult(null); setName(""); setText(""); setLink(""); setImageUrl(""); setFile(null);
  }

  return (
    <div className="create-grid">
      <div className="card">
        <h3>สร้างโฆษณาใหม่</h3>
        <p className="hint">กรอกครบแล้วกดปุ่มเดียว — ระบบสร้างแคมเปญ กลุ่มเป้าหมาย และโฆษณาให้ครบชุด (หยุดไว้ก่อนเสมอ)</p>

        <div className="c-label">สร้างในนาม</div>
        {statusErr && <div className="msg bad">เช็คสถานะไม่ได้: {statusErr} <button className="btn" onClick={loadStatus}>ลองใหม่</button></div>}
        <div className="c-seg">
          {AGENTS.map((a) => {
            const st = status?.find((s) => s.agent === a.id);
            const off = !st?.configured;
            return (
              <button key={a.id} type="button" className={`c-opt ${agent === a.id ? "on" : ""}`} disabled={off}
                title={off ? st?.reason ?? "กำลังเช็คสถานะ…" : undefined} onClick={() => setAgent(a.id)}>
                <b><span className="c-dot" style={{ background: a.color }} />{a.label}
                  {!status && <span className="c-tag wait">กำลังเช็ค…</span>}
                  {status && off && <span className="c-tag">ยังไม่ตั้งค่า</span>}
                  {st?.quota_full && <span className="c-tag">ครบโควตาวันนี้</span>}</b>
                <span>ชื่อขึ้นต้น {a.prefix}</span>
              </button>
            );
          })}
        </div>

        <div className="c-label">ชนิดโฆษณา</div>
        <div className="c-seg">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={`c-opt ${kind === k.id ? "on" : ""}`} onClick={() => setKind(k.id)}>
              <b>{k.icon} {k.label}</b><span>{k.hint}</span>
            </button>
          ))}
        </div>

        <div className="c-row">
          <div className="field"><label htmlFor="c-name">ชื่อแคมเปญ</label>
            <input id="c-name" className="input" value={name} maxLength={80} placeholder="เช่น โปรลดราคา พ.ย." onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="c-budget">งบต่อวัน (บาท)</label>
            <input id="c-budget" className="input" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ""))} />
            <small className="c-hint">สูงสุด {maxBudget.toLocaleString()} บาท/วัน</small></div>
        </div>

        <div className="field"><label htmlFor="c-text">ข้อความโฆษณา</label>
          <textarea id="c-text" className="input c-text" value={text} maxLength={2000} placeholder="เช่น ทักแชทสอบถามสินค้าได้เลยครับ" onChange={(e) => setText(e.target.value)} /></div>

        {kind === "WEBSITE" && (
          <div className="field"><label htmlFor="c-link">ลิงก์เว็บไซต์ปลายทาง</label>
            <input id="c-link" className="input" value={link} placeholder="https://..." onChange={(e) => setLink(e.target.value)} /></div>
        )}

        <div className="c-label">รูปโฆษณา</div>
        <div className={`c-drop ${dragOver ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}>
          {file ? (
            <span>📎 {file.name} <button type="button" className="btn" onClick={() => setFile(null)}>เอาออก</button></span>
          ) : (
            <span>ลากรูปมาวาง หรือ <button type="button" className="c-link" onClick={() => fileInput.current?.click()}>เลือกไฟล์จากเครื่อง</button></span>
          )}
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
        </div>
        {!file && (
          <input className="input" style={{ marginTop: 8, width: "100%" }} value={imageUrl} placeholder="หรือวางลิงก์รูป (ไม่ใส่ = ใช้รูปปกเพจ)" onChange={(e) => setImageUrl(e.target.value)} />
        )}

        <div className="c-label">กลุ่มเป้าหมาย</div>
        {!audOpt ? (
          <div className="c-aud c-hint">{status ? "โหลดตัวเลือกกลุ่มเป้าหมายไม่ได้ — กดลองใหม่ที่ด้านบน" : "กำลังโหลดตัวเลือก…"}</div>
        ) : (
          <div className="c-aud">
            <div className="c-aud-row">
              <label htmlFor="c-age">👤 อายุขั้นต่ำ</label>
              <select id="c-age" className="input c-age" value={age ?? ""} onChange={(e) => setAgeMin(Number(e.target.value))}>
                {ageChoices.map((n) => <option key={n} value={n}>{n} ปีขึ้นไป</option>)}
              </select>
            </div>
            <div className="c-aud-row c-aud-langs">
              <span>🗣 ภาษา</span>
              <div className="c-chips">
                {audOpt.languages.map((l) => (
                  <button key={l.key} type="button" aria-pressed={pickedLangs.includes(l.key)}
                    className={`c-chip ${pickedLangs.includes(l.key) ? "on" : ""}`} onClick={() => toggleLang(l.key)}>
                    {pickedLangs.includes(l.key) ? "✓ " : ""}{l.label}
                  </button>
                ))}
              </div>
            </div>
            <div>📍 {audOpt.fixed}</div>
          </div>
        )}
        <small className="c-hint">อายุขั้นต่ำเลือกได้ {audOpt ? `${audOpt.min_age}–${audOpt.max_age_min}` : "…"} ปี (ข้อกำหนดของ Meta สำหรับไทย) · ไม่มีอายุสูงสุด</small>

        <div className="c-label">กำหนดเวลาเผยแพร่ (เวลาไทย)</div>
        <div className="c-seg">
          <button type="button" className={`c-opt ${startMode === "now" ? "on" : ""}`} onClick={() => setStartMode("now")}>
            <b>▶ เริ่มทันที</b><span>วิ่งตอนที่กดเปิดใน Ads Manager</span>
          </button>
          <button type="button" className={`c-opt ${startMode === "set" ? "on" : ""}`} onClick={() => setStartMode("set")}>
            <b>🕗 กำหนดวันเวลาเริ่ม</b><span>รอถึงเวลาแล้วค่อยวิ่ง</span>
          </button>
        </div>
        {startMode === "set" && (
          <div className="c-when">
            <input type="date" className="input" aria-label="วันที่เริ่ม" value={startDate} min={thDate(0)} onChange={(e) => setStartDate(e.target.value)} />
            <input type="time" className="input" aria-label="เวลาเริ่ม" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
        )}
        <label className="c-check">
          <input type="checkbox" checked={hasEnd} onChange={(e) => setHasEnd(e.target.checked)} /> กำหนดวันสิ้นสุด
        </label>
        {hasEnd && (
          <div className="c-when">
            <input type="date" className="input" aria-label="วันที่สิ้นสุด" value={endDate} min={startMode === "set" ? startDate : thDate(0)} onChange={(e) => setEndDate(e.target.value)} />
            <input type="time" className="input" aria-label="เวลาสิ้นสุด" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        )}
        <div className={`c-hint c-sched ${sched.error ? "bad" : "ok"}`}>
          {sched.error ? `✖ ${sched.error}` : `✔ ${sched.label}${sched.days && budgetNum > 0 ? ` (${sched.days} วัน) · งบรวมไม่เกินประมาณ ฿${(sched.days * budgetNum).toLocaleString()}` : ""}`}
        </div>

        <div className="c-safe">⏸ โฆษณาจะถูกสร้างแบบ <b>หยุดไว้</b> — ยังไม่เสียเงินจนกว่าคุณจะไปกดเปิดใน Ads Manager</div>

        <div className="c-actions">
          <button className="btn primary c-submit" disabled={problems.length > 0 || busy} onClick={submit}>
            {busy ? "กำลังสร้าง… (ประมาณ 20 วินาที)" : "สร้างโฆษณา"}
          </button>
          {left != null && <span className="c-hint">วันนี้สร้างได้อีก {left} จาก {cur!.max_campaigns_per_day} แคมเปญ</span>}
        </div>
        {!busy && problems.length > 0 && status && <div className="c-hint" style={{ marginTop: 8 }}>ยังขาด: {problems.join(" · ")}</div>}
        {submitErr && <div className="msg bad" style={{ marginTop: 12 }}>{submitErr}</div>}

        {result && (
          <div className={`c-result ${result.success ? "ok" : "bad"}`}>
            <b>{result.success ? `✔ สร้างเสร็จ: ${result.campaign_name}` : "✖ สร้างไม่สำเร็จ"}</b>
            <ul>
              {result.steps.map((s) => (
                <li key={s.key} className={s.ok ? "ok" : "bad"}>{s.ok ? "✔" : "✖"} {s.label} — {s.detail}</li>
              ))}
            </ul>
            {result.success && (
              <div className="c-actions">
                {result.ads_manager_url && <a className="btn" href={result.ads_manager_url} target="_blank" rel="noreferrer">เปิดใน Ads Manager ↗</a>}
                <button className="btn" onClick={reset}>สร้างอีกชุด</button>
                {result.dashboard_updated && <span className="c-hint">อัปเดตหน้าภาพรวมแล้ว</span>}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3>ตัวอย่างโฆษณา</h3>
        <p className="hint">หน้าตาโดยประมาณบนฟีด Facebook — เปลี่ยนตามที่กรอกทันที</p>
        <div className="fbp">
          <div className="fbp-h"><div className="fbp-av" /><div><b>{cur?.page_name ?? "เพจของคุณ"}</b><small>ได้รับการสนับสนุน</small></div></div>
          <p className="fbp-text">{text || <span className="fbp-ph">ข้อความโฆษณาจะแสดงตรงนี้</span>}</p>
          {previewImage
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="fbp-img" src={previewImage} alt="รูปโฆษณา" />
            : <div className="fbp-img fbp-noimg">รูปโฆษณา</div>}
          <div className="fbp-cta">
            <div><small>{kind === "MESSENGER" ? "MESSENGER" : (link.replace(/^https?:\/\//, "").split("/")[0] || "เว็บไซต์ของคุณ").toUpperCase()}</small>
              <b>{name || "ชื่อแคมเปญ"}</b></div>
            <span>{kindInfo.cta}</span>
          </div>
        </div>
        <p className="c-hint" style={{ textAlign: "center" }}>รูปที่ใช้: {imageSource}</p>

        <div className="c-checks">
          <b>เช็คก่อนสร้าง</b>
          {!status && <div className="c-hint">กำลังเช็คสถานะ…</div>}
          {cur?.checks.filter((c) => c.key !== "budget").map((c) => (
            <div key={c.key} className={c.ok ? "ok" : "bad"}>{c.ok ? "✔" : "✖"} {c.label} — {c.detail}</div>
          ))}
          {status && (
            <div className={budgetNum > 0 && budgetNum <= maxBudget ? "ok" : "bad"}>
              {budgetNum > 0 && budgetNum <= maxBudget ? "✔" : "✖"} งบต่อวัน — {budgetNum ? budgetNum.toLocaleString() : 0} / เพดาน {maxBudget.toLocaleString()} บาท
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
