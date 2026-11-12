"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AgentId = "claude" | "manus" | "chatgpt";
type Kind = "MESSENGER" | "WEBSITE";

interface CheckItem { key: string; label: string; ok: boolean; detail: string }
interface CreativeOptions {
  max_images: number; max_videos: number; max_bodies: number; max_titles: number; max_assets: number;
  max_video_mb: number; max_total_mb: number; dynamic_kinds: string[]; dynamic_off_reason: string;
}
interface AudienceOptions {
  min_age: number; max_age_min: number; default_age: number;
  min_age_max: number; no_max_age: number; default_age_max: number;
  languages: { key: string; label: string }[]; default_languages: string[]; fixed: string;
  max_interests: number; brand_safety: { label: string; detail: string };
  ai: { provider: string; label: string; ready: boolean; missing: string | null };
}
interface Interest { id: string; name: string; size_lower?: number | null; size_upper?: number | null }
interface AgentStatus {
  agent: AgentId; prefix: string; ready: boolean; configured?: boolean; quota_full?: boolean; reason: string; checks: CheckItem[];
  max_daily_budget_thb: number; max_campaigns_per_day: number; campaigns_today: number | null;
  page_name: string | null; page_cover: string | null; audience?: AudienceOptions;
  creative?: CreativeOptions;
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
const MB = 1024 * 1024;
const fmtMb = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))}MB`;
/** ขนาดกลุ่มคนจาก Meta เช่น 150,000,000–176,000,000 → "≈150–176 ล้าน" · 86,760–102,030 → "≈87–102 พัน" */
const fmtSize = (lo?: number | null, hi?: number | null) => {
  if (!lo || !hi) return "";
  const [d, unit] = hi >= 1e6 ? [1e6, "ล้าน"] : [1e3, "พัน"];
  return `≈${Math.max(1, Math.round(lo / d))}–${Math.max(1, Math.round(hi / d))} ${unit}`;
};
const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/x-m4v";
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

/** URL ชั่วคราวของไฟล์ในเครื่อง (ใช้แสดงตัวอย่าง) — คืนค่าเมื่อรายการไฟล์เปลี่ยน */
function useObjectUrls(files: File[]) {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

function VideoThumb({ url, file, onRemove }: { url: string; file: File; onRemove: () => void }) {
  const [dur, setDur] = useState<number | null>(null);
  return (
    <div className="c-th">
      <video src={url} muted preload="metadata" onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} />
      <span className="c-th-play">▶</span>
      <button type="button" className="c-th-x" aria-label={`เอาคลิป ${file.name} ออก`} onClick={onRemove}>✕</button>
      <span className="c-th-d">{dur != null && Number.isFinite(dur) ? `${fmtDur(dur)} · ` : ""}{fmtMb(file.size)}</span>
    </div>
  );
}

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
  const [ageMax, setAgeMax] = useState<number | null>(null);
  const [interests, setInterests] = useState<Interest[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [aiDown, setAiDown] = useState(false);          // AI ของ agent นี้ล้มรอบล่าสุด → เสนอให้ยืม Claude
  const [kw, setKw] = useState("");                      // ช่องพิมพ์คำค้นเอง
  const [kwBusy, setKwBusy] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false); // กดสร้างตอนยังไม่มีความสนใจ → ถามก่อน
  const kwInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // ชิ้นงานโฆษณาแบบไดนามิก (ค่าเริ่มต้น = ปิด)
  const [dynamic, setDynamic] = useState(false);
  const [dynImages, setDynImages] = useState<File[]>([]);
  const [dynVideos, setDynVideos] = useState<File[]>([]);
  const [texts, setTexts] = useState<string[]>([""]);
  const [titles, setTitles] = useState<string[]>([]);
  const [pvIdx, setPvIdx] = useState(0);
  const [dynMsg, setDynMsg] = useState<string | null>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const vidInput = useRef<HTMLInputElement>(null);
  const imgUrls = useObjectUrls(dynImages);
  const vidUrls = useObjectUrls(dynVideos);

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
  const ageHi = ageMax ?? audOpt?.default_age_max ?? null;
  const ageMaxChoices = audOpt ? Array.from({ length: audOpt.no_max_age - audOpt.min_age_max + 1 }, (_, i) => audOpt.min_age_max + i) : [];
  const ai = cur?.audience?.ai ?? null;   // AI ของ agent ที่เลือก (คีย์แยกต่อ agent)
  // AI ของ agent นี้ใช้ไม่ได้ → ยืม Claude ของ agent อื่นที่พร้อม (เลือก agent Claude ก่อน) · ผลยังสร้างในชื่อ agent เดิม
  const claudeReady = (status ?? []).filter((a) => a.agent !== agent && a.audience?.ai.ready && a.audience.ai.provider === "anthropic");
  const fallback = (!ai?.ready || aiDown) ? (claudeReady.find((a) => a.agent === "claude") ?? claudeReady[0] ?? null) : null;
  useEffect(() => { setAiDown(false); setAiMsg(null); }, [agent]);
  useEffect(() => { if (interests.length) setConfirmEmpty(false); }, [interests.length]);
  function toggleLang(key: string) {
    setLangs(pickedLangs.includes(key) ? pickedLangs.filter((k) => k !== key) : [...pickedLangs, key]);
  }
  const crOpt = status?.find((a) => a.creative)?.creative ?? null;
  const dynAllowed = !!crOpt && crOpt.dynamic_kinds.includes(kind);
  const isDyn = dynamic && dynAllowed;
  const filledTexts = texts.map((t) => t.trim()).filter(Boolean);
  const filledTitles = titles.map((t) => t.trim()).filter(Boolean);
  const videoBytes = dynVideos.reduce((n, f) => n + f.size, 0);
  // ตัวอย่างแต่ละชุดที่ Meta อาจจับคู่: สื่อ × ข้อความหลัก × พาดหัว
  const media = [
    ...dynImages.map((_, i) => ({ type: "image" as const, url: imgUrls[i] })),
    ...dynVideos.map((_, i) => ({ type: "video" as const, url: vidUrls[i] })),
  ];
  const combos = isDyn
    ? media.flatMap((m) => (filledTexts.length ? filledTexts : [""]).flatMap((t) =>
        (filledTitles.length ? filledTitles : [""]).map((h) => ({ m, t, h }))))
    : [];
  const combo = combos.length ? combos[pvIdx % combos.length] : null;
  const imageSource = isDyn
    ? `ชิ้นงานไดนามิก ${dynImages.length} รูป · ${dynVideos.length} คลิป`
    : file ? "ไฟล์จากเครื่อง" : imageUrl.trim() ? "ลิงก์รูป" : "รูปปกเพจ (ค่าเริ่มต้น)";

  function toggleDynamic() {
    if (!dynAllowed) return;
    const on = !dynamic;
    setDynamic(on);
    setDynMsg(null);
    if (on) {
      // เปิดครั้งแรก: ยกรูปและข้อความที่กรอกไว้มาเป็นชิ้นแรก
      if (!dynImages.length && !dynVideos.length && file) setDynImages([file]);
      if (!texts.some((t) => t.trim()) && text.trim()) setTexts([text]);
    }
  }
  function addMedia(list: FileList | File[] | null | undefined, type: "image" | "video") {
    if (!list || !crOpt) return;
    const files = Array.from(list);
    const ok = files.filter((f) => f.type.startsWith(`${type}/`));
    const max = type === "image" ? crOpt.max_images : crOpt.max_videos;
    const cur = type === "image" ? dynImages : dynVideos;
    const room = Math.max(0, max - cur.length);
    const take = ok.slice(0, room);
    const msgs: string[] = [];
    if (ok.length < files.length) msgs.push(`ข้ามไฟล์ที่ไม่ใช่${type === "image" ? "รูป" : "คลิป"} ${files.length - ok.length} ไฟล์`);
    if (take.length < ok.length) msgs.push(`${type === "image" ? "รูป" : "คลิป"}ใส่ได้สูงสุด ${max} ชิ้น — ข้าม ${ok.length - take.length} ไฟล์`);
    setDynMsg(msgs.length ? msgs.join(" · ") : null);
    if (type === "image") setDynImages([...cur, ...take]); else setDynVideos([...cur, ...take]);
    setPvIdx(0);
  }
  function dropMedia(fl: FileList) {
    const files = Array.from(fl);
    addMedia(files.filter((f) => f.type.startsWith("image/")), "image");
    addMedia(files.filter((f) => f.type.startsWith("video/")), "video");
  }

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
    if (isDyn && crOpt) {
      if (!dynImages.length && !dynVideos.length) p.push("ใส่รูปหรือคลิปอย่างน้อย 1 ชิ้น");
      if (!filledTexts.length) p.push("ใส่ข้อความหลักอย่างน้อย 1 แบบ");
      const big = dynVideos.find((f) => f.size > crOpt.max_video_mb * MB);
      if (big) p.push(`คลิป ${big.name} ใหญ่เกิน ${crOpt.max_video_mb}MB`);
      if (videoBytes > crOpt.max_total_mb * MB) p.push(`คลิปรวมกันเกิน ${crOpt.max_total_mb / 1024}GB`);
    } else if (!text.trim()) p.push("ใส่ข้อความโฆษณา");
    if (kind === "WEBSITE" && !/^https?:\/\//.test(link.trim())) p.push("ใส่ลิงก์เว็บไซต์ (ขึ้นต้น https://)");
    if (left === 0) p.push("วันนี้สร้างครบโควตาแล้ว");
    if (sched.error) p.push(sched.error);
    if (audOpt && pickedLangs.length === 0) p.push("เลือกภาษาอย่างน้อย 1 ภาษา");
    return p;
  }, [cur, name, budgetNum, maxBudget, text, kind, link, left, sched.error, audOpt, pickedLangs.length,
    isDyn, crOpt, dynImages.length, dynVideos, filledTexts.length, videoBytes]);

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    if (!f.type.startsWith("image/")) { setSubmitErr("ไฟล์ที่เลือกไม่ใช่รูป"); return; }
    setSubmitErr(null);
    setFile(f);
    setImageUrl("");
  }

  /** ปุ่ม ✨ — via = ยืม AI ของ agent อื่น (ตอน AI ของตัวเองใช้ไม่ได้) */
  async function suggestInterests(via?: AgentStatus) {
    if (aiBusy || kwBusy || (!via && !ai?.ready)) return;
    const copy = isDyn ? filledTexts : [text.trim()].filter(Boolean);
    if (!copy.length) { setAiMsg({ ok: false, text: "ใส่ข้อความโฆษณาก่อน แล้วค่อยให้ AI คิดกลุ่มเป้าหมาย" }); return; }
    setAiBusy(true); setAiMsg(null);
    try {
      const r = await fetch("/api/interests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, ai_agent: via?.agent, texts: copy, titles: isDyn ? filledTitles : [], link_url: kind === "WEBSITE" ? link.trim() : "" }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      if (!j.result.success) throw new Error(j.result.error);
      setInterests(j.result.interests);   // กดซ้ำ = แทนที่ชุดเดิมทั้งหมด
      if (!via) setAiDown(false);
      setAiMsg({ ok: true, text: `${j.result.ai}${via ? " (ยืมมาใช้แทน)" : ""} คิดจากข้อความ ได้ ${j.result.interests.length} รายการ` });
    } catch (e) {
      if (!via) setAiDown(true);
      setAiMsg({ ok: false, text: (e as Error).message });
    } finally {
      setAiBusy(false);
    }
  }

  /** ช่องพิมพ์คำค้นเอง — ค้นตรงในคลังของ Meta ไม่ใช้ AI · ต่อท้ายรายการเดิม */
  async function searchInterests() {
    if (aiBusy || kwBusy) return;
    const words = kw.split(/[,，]/).map((w) => w.trim()).filter(Boolean);
    if (!words.length) { setAiMsg({ ok: false, text: "พิมพ์คำค้นก่อน เช่น ERP, บัญชี (คั่นหลายคำด้วย ,)" }); return; }
    setKwBusy(true); setAiMsg(null);
    try {
      const r = await fetch("/api/interests", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, mode: "search", words, have: interests.map((x) => x.id) }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      if (!j.result.success) throw new Error(j.result.error);
      const got: Interest[] = j.result.interests;
      setInterests((cur) => [...cur, ...got.filter((x) => !cur.some((c) => c.id === x.id))]);
      setKw("");
      const miss = [...(j.result.missed ?? []), ...(j.result.skipped ?? [])];
      setAiMsg({ ok: true, text: `ค้นใน Meta ได้ ${got.length} รายการ${miss.length ? ` · ไม่ได้เพิ่ม: ${miss.join(", ")}` : ""}` });
    } catch (e) {
      setAiMsg({ ok: false, text: (e as Error).message });
    } finally {
      setKwBusy(false);
    }
  }

  async function submit(allowEmpty = false) {
    if (problems.length || busy) return;
    if (!interests.length && !allowEmpty) { setConfirmEmpty(true); return; }
    setConfirmEmpty(false);
    setBusy(true); setResult(null); setSubmitErr(null);
    const fd = new FormData();
    fd.set("agent", agent); fd.set("kind", kind); fd.set("name", name.trim());
    fd.set("daily_budget_thb", String(budgetNum)); fd.set("text", text.trim());
    if (kind === "WEBSITE") fd.set("link_url", link.trim());
    if (sched.start_time) fd.set("start_time", sched.start_time);
    if (sched.end_time) fd.set("end_time", sched.end_time);
    if (age != null) fd.set("age_min", String(age));
    if (ageHi != null) fd.set("age_max", String(ageHi));
    if (interests.length) fd.set("interests", JSON.stringify(interests.map(({ id, name }) => ({ id, name }))));
    pickedLangs.forEach((k) => fd.append("languages", k));
    if (isDyn) {
      fd.set("dynamic", "1");
      fd.delete("text");
      dynImages.forEach((f) => fd.append("images", f));
      dynVideos.forEach((f) => fd.append("videos", f));
      filledTexts.forEach((t) => fd.append("texts", t));
      filledTitles.forEach((t) => fd.append("titles", t));
    } else if (file) fd.set("image", file); else if (imageUrl.trim()) fd.set("image_url", imageUrl.trim());
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
    setDynImages([]); setDynVideos([]); setTexts([""]); setTitles([]); setPvIdx(0);
    setInterests([]); setAiMsg(null); setKw(""); setConfirmEmpty(false);
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

        {!isDyn && (<div className="field"><label htmlFor="c-text">ข้อความโฆษณา</label>
          <textarea id="c-text" className="input c-text" value={text} maxLength={2000} placeholder="เช่น ทักแชทสอบถามสินค้าได้เลยครับ" onChange={(e) => setText(e.target.value)} /></div>)}

        {kind === "WEBSITE" && (
          <div className="field"><label htmlFor="c-link">ลิงก์เว็บไซต์ปลายทาง</label>
            <input id="c-link" className="input" value={link} placeholder="https://..." onChange={(e) => setLink(e.target.value)} /></div>
        )}

        {crOpt && (
          <div className={`c-dyn ${dynAllowed ? "" : "off"}`}>
            <div>
              <b>ชิ้นงานโฆษณาแบบไดนามิก</b>
              <small>{dynAllowed
                ? "ใส่รูป คลิป และข้อความได้หลายแบบ — Meta จะจับคู่ให้เองและเลือกชุดที่คนตอบสนองดีที่สุด"
                : crOpt.dynamic_off_reason}</small>
            </div>
            <span className="c-dyn-l">{isDyn ? "เปิด" : "ปิด"}</span>
            <button type="button" role="switch" aria-checked={isDyn} aria-label="ชิ้นงานโฆษณาแบบไดนามิก"
              className={`c-switch ${isDyn ? "on" : ""}`} disabled={!dynAllowed} onClick={toggleDynamic} />
          </div>
        )}

        {isDyn && crOpt ? (<>
          <div className="c-label c-row-h"><span>🖼 รูป</span><span className={dynImages.length >= crOpt.max_images ? "c-cnt full" : "c-cnt"}>{dynImages.length} / {crOpt.max_images}</span></div>
          <div className="c-grid" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); dropMedia(e.dataTransfer.files); }}>
            {dynImages.map((f, i) => (
              <div key={`${f.name}-${i}`} className="c-th">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imgUrls[i]} alt={f.name} />
                <button type="button" className="c-th-x" aria-label={`เอารูป ${f.name} ออก`} onClick={() => { setDynImages(dynImages.filter((_, j) => j !== i)); setPvIdx(0); }}>✕</button>
              </div>
            ))}
            {dynImages.length < crOpt.max_images && <button type="button" className="c-add" onClick={() => imgInput.current?.click()}>＋<br />เพิ่มรูป</button>}
          </div>
          <div className="c-label c-row-h"><span>🎬 คลิป</span><span className={dynVideos.length >= crOpt.max_videos ? "c-cnt full" : "c-cnt"}>{dynVideos.length} / {crOpt.max_videos}</span></div>
          <div className="c-grid" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); dropMedia(e.dataTransfer.files); }}>
            {dynVideos.map((f, i) => (
              <VideoThumb key={`${f.name}-${i}`} url={vidUrls[i]} file={f} onRemove={() => { setDynVideos(dynVideos.filter((_, j) => j !== i)); setPvIdx(0); }} />
            ))}
            {dynVideos.length < crOpt.max_videos && <button type="button" className="c-add" onClick={() => vidInput.current?.click()}>＋<br />เพิ่มคลิป</button>}
          </div>
          <small className="c-hint">คลิป MP4 / MOV ไม่เกิน {crOpt.max_video_mb}MB ต่อไฟล์ · รวมทั้งชุด {fmtMb(videoBytes)} / {crOpt.max_total_mb / 1024}GB · ลากรูปหรือคลิปมาวางในช่องได้</small>
          <div className="c-bar"><i style={{ width: `${Math.min(100, (videoBytes / (crOpt.max_total_mb * MB)) * 100)}%` }} /></div>
          {dynMsg && <div className="c-hint c-sched bad">{dynMsg}</div>}
          <input ref={imgInput} type="file" multiple accept={IMAGE_ACCEPT} hidden onChange={(e) => { addMedia(e.target.files, "image"); e.target.value = ""; }} />
          <input ref={vidInput} type="file" multiple accept={VIDEO_ACCEPT} hidden onChange={(e) => { addMedia(e.target.files, "video"); e.target.value = ""; }} />

          <div className="c-label c-row-h"><span>ข้อความหลัก</span><span className="c-cnt">{texts.length} / {crOpt.max_bodies}</span></div>
          {texts.map((t, i) => (
            <div key={i} className="c-multi">
              <textarea className="input c-text" value={t} maxLength={2000} aria-label={`ข้อความหลักแบบที่ ${i + 1}`}
                placeholder={i === 0 ? "เช่น รับทำเว็บไซต์ ปรึกษาฟรี" : "ข้อความอีกแบบ"} onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))} />
              {texts.length > 1 && <button type="button" className="btn" aria-label={`ลบข้อความหลักแบบที่ ${i + 1}`} onClick={() => { setTexts(texts.filter((_, j) => j !== i)); setPvIdx(0); }}>✕</button>}
            </div>
          ))}
          {texts.length < crOpt.max_bodies && <button type="button" className="btn c-more" onClick={() => setTexts([...texts, ""])}>＋ เพิ่มข้อความหลัก</button>}

          <div className="c-label c-row-h"><span>พาดหัว <small className="c-hint">(ไม่ใส่ก็ได้)</small></span><span className="c-cnt">{titles.length} / {crOpt.max_titles}</span></div>
          {titles.map((t, i) => (
            <div key={i} className="c-multi">
              <input className="input" value={t} maxLength={255} aria-label={`พาดหัวแบบที่ ${i + 1}`} placeholder="เช่น รับทำระบบ ERP / เว็บไซต์"
                onChange={(e) => setTitles(titles.map((x, j) => (j === i ? e.target.value : x)))} />
              <button type="button" className="btn" aria-label={`ลบพาดหัวแบบที่ ${i + 1}`} onClick={() => { setTitles(titles.filter((_, j) => j !== i)); setPvIdx(0); }}>✕</button>
            </div>
          ))}
          {titles.length < crOpt.max_titles && <button type="button" className="btn c-more" onClick={() => setTitles([...titles, ""])}>＋ เพิ่มพาดหัว</button>}
        </>) : (<>
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
        </>)}

        <div className="c-label">กลุ่มเป้าหมาย</div>
        {!audOpt ? (
          <div className="c-aud c-hint">{status ? "โหลดตัวเลือกกลุ่มเป้าหมายไม่ได้ — กดลองใหม่ที่ด้านบน" : "กำลังโหลดตัวเลือก…"}</div>
        ) : (
          <div className="c-aud">
            <div className="c-aud-row">
              <label htmlFor="c-age" className="c-aud-k">👤 อายุ</label>
              <select id="c-age" className="input c-age" aria-label="อายุขั้นต่ำ" value={age ?? ""} onChange={(e) => setAgeMin(Number(e.target.value))}>
                {ageChoices.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              ถึง
              <select id="c-age-max" className="input c-age" aria-label="อายุสูงสุด" value={ageHi ?? ""} onChange={(e) => setAgeMax(Number(e.target.value))}>
                {ageMaxChoices.map((n) => <option key={n} value={n}>{n === audOpt.no_max_age ? `${n}+` : n}</option>)}
              </select>
              ปี {ageHi != null && ageHi < audOpt.no_max_age && <span className="c-sugg">ค่าแนะนำ</span>}
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
            <div className="c-aud-row c-aud-langs">
              <span>🎯 ความสนใจ</span>
              <div className="c-int">
                <div className="c-aud-row c-int-bar">
                  <button type="button" className="btn c-ai" onClick={() => suggestInterests()} disabled={!ai?.ready || aiBusy || kwBusy}>
                    {aiBusy ? "AI กำลังคิด…" : "✨ ให้ AI คิดกลุ่มเป้าหมาย"}
                  </button>
                  {ai?.ready && !aiBusy && <span className="c-hint">{ai.label} คิดจากข้อความหลัก{isDyn ? " + พาดหัว" : ""}{kind === "WEBSITE" ? " + ลิงก์" : ""}</span>}
                  <span className="c-cnt">{interests.length} / {audOpt.max_interests}</span>
                </div>
                {interests.length > 0 && (
                  <div className="c-chips">
                    {interests.map((it) => (
                      <span key={it.id} className="c-itag">
                        {it.name} {fmtSize(it.size_lower, it.size_upper) && <small>{fmtSize(it.size_lower, it.size_upper)}</small>}
                        <button type="button" aria-label={`ลบความสนใจ ${it.name}`} onClick={() => setInterests(interests.filter((x) => x.id !== it.id))}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
                {ai && !ai.ready && <div className="c-warn">{ai.missing}</div>}
                {aiMsg && <div className={aiMsg.ok ? "c-hint" : "c-warn"}>{aiMsg.ok ? "✓ " : "✕ "}{aiMsg.text}</div>}
                {fallback && !aiBusy && (
                  <div className="c-aud-row c-int-bar">
                    <button type="button" className="btn" onClick={() => suggestInterests(fallback)} disabled={kwBusy}>
                      ✨ ใช้ {fallback.audience!.ai.label} หาแทนรอบนี้
                    </button>
                    <span className="c-hint">ยืม AI ของ {fallback.prefix} · โฆษณายังสร้างในชื่อ {cur?.prefix ?? agent} เหมือนเดิม</span>
                  </div>
                )}
                <div className="c-aud-row c-int-bar">
                  <input ref={kwInput} className="input c-kw" value={kw} maxLength={200} aria-label="พิมพ์คำค้นความสนใจเอง"
                    placeholder="หรือพิมพ์คำค้นเอง เช่น ERP, บัญชี, กาแฟ" onChange={(e) => setKw(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchInterests(); } }} />
                  <button type="button" className="btn" onClick={searchInterests} disabled={kwBusy || aiBusy || !kw.trim()}>
                    {kwBusy ? "กำลังค้น…" : "ค้นใน Meta"}
                  </button>
                </div>
                <div className="c-hint">ค้นตรงในคลังของ Meta ไม่ใช้ AI · คั่นหลายคำด้วย , · เพิ่มต่อท้ายรายการเดิม</div>
                {interests.length > 0 && <div className="c-hint">ค่าแนะนำ · Meta อาจขยายไปคนนอกกลุ่มนี้ถ้าได้ผลดีกว่า · ลบได้ก่อนกดสร้าง</div>}
              </div>
            </div>
            <div className="c-aud-row">
              <span className="c-aud-k">🛡 คลังเนื้อหา</span><b className="c-ok">{audOpt.brand_safety.label}</b>
              <span className="c-hint">— {audOpt.brand_safety.detail}</span>
            </div>
            <div>📍 {audOpt.fixed}</div>
          </div>
        )}
        <small className="c-hint">อายุขั้นต่ำ {audOpt ? `${audOpt.min_age}–${audOpt.max_age_min}` : "…"} · อายุสูงสุด {audOpt ? `${audOpt.min_age_max}–${audOpt.no_max_age} (${audOpt.no_max_age}+ = ไม่จำกัด)` : "…"} · อายุสูงสุดและความสนใจเป็นค่าแนะนำของ Advantage+</small>

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
          <button className="btn primary c-submit" disabled={problems.length > 0 || busy} onClick={() => submit()}>
            {busy ? (isDyn && dynVideos.length ? "กำลังอัปโหลดและรอ Meta ประมวลผลคลิป… (อาจนานหลายนาที)" : "กำลังสร้าง… (ประมาณ 20 วินาที)") : "สร้างโฆษณา"}
          </button>
          {left != null && <span className="c-hint">วันนี้สร้างได้อีก {left} จาก {cur!.max_campaigns_per_day} แคมเปญ</span>}
        </div>
        {!busy && problems.length > 0 && status && <div className="c-hint" style={{ marginTop: 8 }}>ยังขาด: {problems.join(" · ")}</div>}
        {confirmEmpty && !busy && (
          <div className="c-confirm" role="alertdialog" aria-label="ยังไม่มีความสนใจ">
            <b>⚠ ยังไม่มีความสนใจ</b>
            <div>ถ้าสร้างตอนนี้ Meta จะหากลุ่มเองจากทั้งประเทศ — ทำได้ แต่ใช้เวลาเรียนรู้นานกว่า และงบน้อยอาจกระจายเกินไป</div>
            <div className="c-actions">
              <button className="btn primary" onClick={() => { setConfirmEmpty(false); kwInput.current?.focus(); }}>กลับไปเพิ่มความสนใจ</button>
              <button className="btn" onClick={() => submit(true)}>สร้างแบบไม่มีความสนใจ</button>
            </div>
          </div>
        )}
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
          <p className="fbp-text">{(isDyn ? combo?.t : text) || <span className="fbp-ph">ข้อความโฆษณาจะแสดงตรงนี้</span>}</p>
          {isDyn
            ? combo
              ? combo.m.type === "video"
                ? <video className="fbp-img" src={combo.m.url} muted controls preload="metadata" />
                // eslint-disable-next-line @next/next/no-img-element
                : <img className="fbp-img" src={combo.m.url} alt="รูปโฆษณา" />
              : <div className="fbp-img fbp-noimg">รูป / คลิปโฆษณา</div>
            : previewImage
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="fbp-img" src={previewImage} alt="รูปโฆษณา" />
            : <div className="fbp-img fbp-noimg">รูปโฆษณา</div>}
          <div className="fbp-cta">
            <div><small>{kind === "MESSENGER" ? "MESSENGER" : (link.replace(/^https?:\/\//, "").split("/")[0] || "เว็บไซต์ของคุณ").toUpperCase()}</small>
              <b>{(isDyn && combo?.h) || name || "ชื่อแคมเปญ"}</b></div>
            <span>{kindInfo.cta}</span>
          </div>
        </div>
        {isDyn && combos.length > 0 && (
          <div className="c-pvnav">
            <button type="button" className="btn" aria-label="ชุดก่อนหน้า" onClick={() => setPvIdx((pvIdx - 1 + combos.length) % combos.length)}>‹</button>
            <span>ตัวอย่างชุดที่ {(pvIdx % combos.length) + 1} จาก {combos.length} ({media.length} สื่อ × {Math.max(1, filledTexts.length)} ข้อความ × {Math.max(1, filledTitles.length)} พาดหัว)</span>
            <button type="button" className="btn" aria-label="ชุดถัดไป" onClick={() => setPvIdx((pvIdx + 1) % combos.length)}>›</button>
          </div>
        )}
        <p className="c-hint" style={{ textAlign: "center" }}>{isDyn ? "ชิ้นงาน" : "รูปที่ใช้"}: {imageSource}</p>

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
