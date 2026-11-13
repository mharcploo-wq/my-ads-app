"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AdsetInterests from "@/components/AdsetInterests";
import { LiveOnAirButton } from "@/components/LiveAds";
import InterestPicker, { Interest } from "@/components/InterestPicker";
import { clearDraft, FileGroup, FormDraft, loadDraft, loadFiles, saveDraft, saveFiles } from "@/lib/draft";
import type { AdPage, LiveEvent, LiveNext, LiveOptions } from "@/lib/creator";

type AgentId = "claude" | "manus" | "chatgpt";
type Kind = "MESSENGER" | "WEBSITE" | "LIVE";

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
interface AgentStatus {
  agent: AgentId; prefix: string; ready: boolean; configured?: boolean; quota_full?: boolean; reason: string; checks: CheckItem[];
  max_daily_budget_thb: number; max_campaigns_per_day: number; campaigns_today: number | null;
  page_name: string | null; page_cover: string | null; audience?: AudienceOptions;
  creative?: CreativeOptions; live?: LiveOptions;
  pages?: AdPage[]; pages_error?: string | null; default_page_id?: string;
}
interface CreateResult {
  success: boolean; steps: CheckItem[]; campaign_name?: string; ads_manager_url?: string; dashboard_updated?: boolean;
  adset_id?: string; live_next?: LiveNext; page?: { id: string; name: string };
}

const AGENTS: { id: AgentId; label: string; color: string; prefix: string }[] = [
  { id: "claude", label: "Claude", color: "var(--series-1)", prefix: "CLD-" },
  { id: "manus", label: "Manus", color: "var(--series-2)", prefix: "MANUS-" },
  { id: "chatgpt", label: "ChatGPT", color: "var(--series-3)", prefix: "GPT-" },
];
const KINDS: { id: Kind; icon: string; label: string; hint: string; cta: string }[] = [
  { id: "MESSENGER", icon: "💬", label: "ยิงข้อความ", hint: "คนกดปุ่ม \"ส่งข้อความ\" ทักแชทเพจ", cta: "ส่งข้อความ" },
  { id: "WEBSITE", icon: "🔗", label: "พาเข้าเว็บไซต์", hint: "คนกดปุ่ม \"ดูเพิ่มเติม\" ไปหน้าเว็บ", cta: "ดูเพิ่มเติม" },
  { id: "LIVE", icon: "🔴", label: "Live สด", hint: "การรับรู้ · คนเห็น Live มากที่สุด", cta: "ดูเพิ่มเติม" },
];

/** วันเวลาของ Live แบบไทย เช่น "จ. 16 พ.ย. 2569 · 06:00 น." */
const fmtLive = (iso: string) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return `${day} · ${fmtClock(d)} น.`;
};
const fmtClock = (d: Date) => d.toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false });
/** เวลาที่เหลือก่อนเริ่ม Live เช่น "อีก 2 วัน 13 ชม." */
const fmtLeft = (ms: number) => {
  if (ms <= 0) return "เริ่มไปแล้ว";
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `อีก ${Math.max(1, Math.round(ms / 60_000))} นาที`;
  return h >= 24 ? `อีก ${Math.floor(h / 24)} วัน${h % 24 ? ` ${h % 24} ชม.` : ""}` : `อีก ${h} ชม.`;
};

/** วันเวลาไทย: "YYYY-MM-DD" + "HH:MM" → เวลาจริง (ms) */
const thMs = (d: string, t: string) => Date.parse(`${d}T${t || "00:00"}:00+07:00`);
const thDate = (offsetDays: number) => new Date(Date.now() + 7 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const fmtTh = (d: string, t: string) => { const [y, m, dd] = d.split("-"); return `${dd}/${m}/${y} ${t}`; };
const MB = 1024 * 1024;
const fmtMb = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))}MB`;
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

/** ค่าเริ่มต้นของฟอร์ม (ตอนเปิดครั้งแรก และหลังกดรีเซ็ต) */
const blankForm = (): Omit<FormDraft, "agent" | "savedAt"> => ({
  kind: "MESSENGER", name: "", budget: "300", text: "", link: "", imageUrl: "",
  startMode: "now", startDate: thDate(1), startTime: "08:00", hasEnd: false, endDate: thDate(8), endTime: "23:59",
  ageMin: null, ageMax: null, langs: null, interests: [], dynamic: false, texts: [""], titles: [],
  liveId: "", liveHours: null, pageId: "",
});

export default function CreatePanel({ onCreated }: { onCreated: () => void }) {
  // ร่างที่กรอกค้างไว้ (สลับแท็บ/รีเฟรช/ปิดเบราว์เซอร์แล้วกลับมาได้) — ล้างเมื่อกดรีเซ็ตเท่านั้น
  const [d0] = useState(() => ({ ...blankForm(), ...(loadDraft() ?? {}) }));
  const [status, setStatus] = useState<AgentStatus[] | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentId>(AGENTS.some((a) => a.id === d0.agent) ? d0.agent as AgentId : "claude");
  const [kind, setKind] = useState<Kind>(KINDS.some((k) => k.id === d0.kind) ? d0.kind as Kind : "MESSENGER");
  const [name, setName] = useState(d0.name);
  const [budget, setBudget] = useState(d0.budget);
  const [text, setText] = useState(d0.text);
  const [link, setLink] = useState(d0.link);
  const [imageUrl, setImageUrl] = useState(d0.imageUrl);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  // กำหนดเวลาเผยแพร่ (เวลาไทย)
  const [startMode, setStartMode] = useState<"now" | "set">(d0.startMode === "set" ? "set" : "now");
  const [startDate, setStartDate] = useState(d0.startDate);
  const [startTime, setStartTime] = useState(d0.startTime);
  const [hasEnd, setHasEnd] = useState(!!d0.hasEnd);
  const [endDate, setEndDate] = useState(d0.endDate);
  const [endTime, setEndTime] = useState(d0.endTime);
  // กลุ่มเป้าหมาย — null = ยังไม่แตะ ใช้ค่าเริ่มต้นจาก server.py
  const [ageMin, setAgeMin] = useState<number | null>(d0.ageMin);
  const [langs, setLangs] = useState<string[] | null>(d0.langs);
  const [ageMax, setAgeMax] = useState<number | null>(d0.ageMax);
  const [interests, setInterests] = useState<Interest[]>(d0.interests);
  const [pickerKey, setPickerKey] = useState(0);         // เปลี่ยนค่า = ล้างข้อความ/ช่องค้นในกล่องความสนใจ
  const [editAdset, setEditAdset] = useState(false);     // กล่องเพิ่มความสนใจให้ Ad Set ที่เพิ่งสร้าง
  const [confirmEmpty, setConfirmEmpty] = useState(false); // กดสร้างตอนยังไม่มีความสนใจ → ถามก่อน
  const kwInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // ชิ้นงานโฆษณาแบบไดนามิก (ค่าเริ่มต้น = ปิด)
  const [dynamic, setDynamic] = useState(!!d0.dynamic);
  const [dynImages, setDynImages] = useState<File[]>([]);
  const [dynVideos, setDynVideos] = useState<File[]>([]);
  const [texts, setTexts] = useState<string[]>(d0.texts.length ? d0.texts : [""]);
  const [titles, setTitles] = useState<string[]>(d0.titles);
  const [savedAt, setSavedAt] = useState<number | null>(d0.savedAt ?? null);   // บันทึกร่างล่าสุด
  const [filesReady, setFilesReady] = useState(false);   // โหลดรูป/คลิปที่เก็บไว้เสร็จแล้ว (ก่อนนั้นห้ามเขียนทับ)
  const [lostFiles, setLostFiles] = useState<string[]>([]);   // ไฟล์ที่เก็บไม่ลง (ต้องใส่ใหม่ถ้ารีเฟรช)
  const [askReset, setAskReset] = useState(false);
  const stored = useRef<Record<FileGroup, File[]>>({ single: [], images: [], videos: [] });   // ชุดที่เก็บอยู่ตอนนี้
  const [pvIdx, setPvIdx] = useState(0);
  const [dynMsg, setDynMsg] = useState<string | null>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const vidInput = useRef<HTMLInputElement>(null);
  const imgUrls = useObjectUrls(dynImages);
  const vidUrls = useObjectUrls(dynVideos);
  // ชนิด Live สด
  const [liveId, setLiveId] = useState(d0.liveId ?? "");
  const [liveHours, setLiveHours] = useState<number | null>(d0.liveHours ?? null);
  const [lives, setLives] = useState<LiveEvent[] | null>(null);
  const [livesErr, setLivesErr] = useState<string | null>(null);
  const [livesBusy, setLivesBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());   // นับเวลาที่เหลือก่อนเริ่ม Live
  const [pageId, setPageId] = useState(d0.pageId ?? "");   // "" = เพจประจำ agent

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

  // รูป/คลิปที่เก็บไว้ในร่าง — โหลดครั้งเดียวตอนเปิดฟอร์ม
  useEffect(() => {
    let alive = true;
    loadFiles().then((f) => {
      if (!alive) return;
      stored.current = f;
      if (f.single[0]) setFile(f.single[0]);
      if (f.images.length) setDynImages(f.images);
      if (f.videos.length) setDynVideos(f.videos);
      setFilesReady(true);
    });
    return () => { alive = false; };
  }, []);

  // บันทึกข้อความทุกช่องลงร่าง (รอให้หยุดพิมพ์ก่อนสักครู่) · ฟอร์มยังว่างเหมือนเพิ่งเปิด = ไม่ต้องบันทึก
  useEffect(() => {
    const t = setTimeout(() => {
      const form = { kind, name, budget, text, link, imageUrl, startMode, startDate, startTime, hasEnd, endDate,
        endTime, ageMin, ageMax, langs, interests, dynamic, texts, titles, liveId, liveHours, pageId };
      if (JSON.stringify(form) === JSON.stringify(blankForm()) && !loadDraft()) return;
      const at = Date.now();
      if (saveDraft({ ...form, agent, savedAt: at })) setSavedAt(at);
    }, 400);
    return () => clearTimeout(t);
  }, [agent, kind, name, budget, text, link, imageUrl, startMode, startDate, startTime, hasEnd, endDate, endTime,
    ageMin, ageMax, langs, interests, dynamic, texts, titles, liveId, liveHours, pageId]);

  // บันทึกรูป/คลิปเมื่อรายการเปลี่ยน (ข้ามชุดที่เพิ่งโหลดมา ไม่ต้องเขียนซ้ำ)
  useEffect(() => {
    if (!filesReady) return;
    const now: Record<FileGroup, File[]> = { single: file ? [file] : [], images: dynImages, videos: dynVideos };
    const groups = (Object.keys(now) as FileGroup[]).filter((g) =>
      now[g].length !== stored.current[g].length || now[g].some((f, i) => f !== stored.current[g][i]));
    if (!groups.length) return;
    stored.current = now;
    Promise.all(groups.map((g) => saveFiles(g, now[g]))).then((lost) => {
      setLostFiles((prev) => [...prev.filter((n) => !groups.some((g) => now[g].some((f) => f.name === n))), ...lost.flat()]);
      setSavedAt(Date.now());
    });
  }, [filesReady, file, dynImages, dynVideos]);

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
  // เพจที่จะยิง: ที่เลือกไว้ (ถ้ายังอยู่ในรายการของ agent นี้) → เพจประจำ agent
  const pages = cur?.pages ?? [];
  const page = pages.find((p) => p.id === pageId) ?? pages.find((p) => p.id === cur?.default_page_id) ?? null;
  const pageName = page?.name ?? cur?.page_name ?? null;
  const pageCover = page ? page.cover ?? null : cur?.page_cover ?? null;
  const previewImage = filePreview || imageUrl.trim() || pageCover || null;
  const audOpt = status?.find((a) => a.audience)?.audience ?? null;
  const age = ageMin ?? audOpt?.default_age ?? null;
  const pickedLangs = langs ?? audOpt?.default_languages ?? [];
  const ageChoices = audOpt ? Array.from({ length: audOpt.max_age_min - audOpt.min_age + 1 }, (_, i) => audOpt.min_age + i) : [];
  const ageHi = ageMax ?? audOpt?.default_age_max ?? null;
  const ageMaxChoices = audOpt ? Array.from({ length: audOpt.no_max_age - audOpt.min_age_max + 1 }, (_, i) => audOpt.min_age_max + i) : [];
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

  // ---- Live สด · การรับรู้ ----
  const isLive = kind === "LIVE";
  const liveOpt = status?.find((a) => a.live)?.live ?? null;
  const hours = liveHours ?? liveOpt?.default_hours ?? 2;
  const hourChoices = liveOpt ? Array.from({ length: liveOpt.max_hours - liveOpt.min_hours + 1 }, (_, i) => liveOpt.min_hours + i) : [hours];
  const liveBudgetFor = (h: number) => (liveOpt ? Math.min(maxBudget, h * liveOpt.thb_per_hour) : null);
  const live = lives?.find((l) => l.id === liveId) ?? null;
  const liveStart = live ? Date.parse(live.start_time) : null;
  const liveSoon = liveStart !== null && !!liveOpt && liveStart - now < liveOpt.lead_hours * 3600_000;

  const loadLives = useCallback(async () => {
    setLivesBusy(true); setLivesErr(null);
    try {
      const r = await fetch(`/api/lives?agent=${agent}${page ? `&page_id=${page.id}` : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      if (!j.result.success) throw new Error(j.result.error);
      setLives(j.result.lives as LiveEvent[]);
      setNow(Date.now());
    } catch (e) {
      setLives(null); setLivesErr((e as Error).message);
    } finally {
      setLivesBusy(false);
    }
  }, [agent, page?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const canLoadLives = isLive && !!cur?.configured;
  useEffect(() => { if (canLoadLives) loadLives(); }, [canLoadLives, loadLives]);
  // Live ที่เลือกไว้หายไป (เริ่มแล้ว/ยกเลิก) หรือยังไม่ได้เลือก → เลือกอันที่ใกล้สุดให้
  useEffect(() => {
    if (lives && !lives.some((l) => l.id === liveId)) setLiveId(lives[0]?.id ?? "");
  }, [lives, liveId]);
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [isLive]);

  function pickKind(k: Kind) {
    // เปลี่ยนมาเป็น Live: งบเปลี่ยนเป็นงบรวมตามความยาว Live (แก้เองได้)
    if (k === "LIVE" && kind !== "LIVE") { const b = liveBudgetFor(hours); if (b) setBudget(String(b)); }
    setKind(k);
  }
  function pickHours(h: number) {
    setLiveHours(h);
    const b = liveBudgetFor(h);
    if (b) setBudget(String(b));
  }
  async function copyLiveText(t: string) {
    try { await navigator.clipboard.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* เบราว์เซอร์ไม่ให้คัดลอก */ }
  }

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
    if (!Number.isInteger(budgetNum) || budgetNum <= 0) p.push(isLive ? "ใส่งบรวมเป็นตัวเลขเต็ม" : "ใส่งบต่อวันเป็นตัวเลขเต็ม");
    else if (budgetNum > maxBudget) p.push(`งบเกินเพดาน ${maxBudget.toLocaleString()} บาท`);
    if (isLive) {
      if (!live) p.push(lives?.length === 0 ? "เพจยังไม่มี Live ที่นัดไว้" : "เลือก Live ที่นัดไว้");
      if (left === 0) p.push("วันนี้สร้างครบโควตาแล้ว");
      if (audOpt && pickedLangs.length === 0) p.push("เลือกภาษาอย่างน้อย 1 ภาษา");
      return p;   // Live ไม่มีรูป/ลิงก์/กำหนดเวลาเอง · ข้อความไม่บังคับ
    }
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
    isDyn, crOpt, dynImages.length, dynVideos, filledTexts.length, videoBytes, isLive, live, lives]);

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    if (!f.type.startsWith("image/")) { setSubmitErr("ไฟล์ที่เลือกไม่ใช่รูป"); return; }
    setSubmitErr(null);
    setFile(f);
    setImageUrl("");
  }

  async function submit(allowEmpty = false) {
    if (problems.length || busy) return;
    if (!interests.length && !allowEmpty) { setConfirmEmpty(true); return; }
    setConfirmEmpty(false);
    setBusy(true); setResult(null); setSubmitErr(null);
    const fd = new FormData();
    fd.set("agent", agent); fd.set("kind", kind); fd.set("name", name.trim());
    if (page) fd.set("page_id", page.id);
    fd.set("daily_budget_thb", String(budgetNum)); fd.set("text", text.trim());
    if (kind === "WEBSITE") fd.set("link_url", link.trim());
    if (isLive) { fd.set("live_id", liveId); fd.set("live_hours", String(hours)); }
    else {
      if (sched.start_time) fd.set("start_time", sched.start_time);
      if (sched.end_time) fd.set("end_time", sched.end_time);
    }
    if (age != null) fd.set("age_min", String(age));
    if (ageHi != null) fd.set("age_max", String(ageHi));
    if (interests.length) fd.set("interests", JSON.stringify(interests.map(({ id, name }) => ({ id, name }))));
    pickedLangs.forEach((k) => fd.append("languages", k));
    if (isDyn && !isLive) {
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

  /** ปุ่มรีเซ็ต (หลังยืนยัน): ล้างทุกช่อง รูป/คลิป และร่างที่เก็บไว้ — คงผู้สร้างที่เลือกไว้ */
  async function reset() {
    const b = blankForm();
    setAskReset(false); setResult(null); setSubmitErr(null); setConfirmEmpty(false); setEditAdset(false);
    setKind(b.kind as Kind); setName(b.name); setBudget(b.budget); setText(b.text); setLink(b.link); setImageUrl(b.imageUrl);
    setStartMode(b.startMode); setStartDate(b.startDate); setStartTime(b.startTime);
    setHasEnd(b.hasEnd); setEndDate(b.endDate); setEndTime(b.endTime);
    setAgeMin(b.ageMin); setAgeMax(b.ageMax); setLangs(b.langs); setInterests([]); setPickerKey((k) => k + 1);
    setDynamic(b.dynamic); setTexts(b.texts); setTitles(b.titles); setPvIdx(0); setDynMsg(null);
    setLiveId(b.liveId); setLiveHours(b.liveHours); setPageId(b.pageId ?? "");
    stored.current = { single: [], images: [], videos: [] };
    setFile(null); setDynImages([]); setDynVideos([]); setLostFiles([]);
    await clearDraft();
    setSavedAt(null);
  }
  // สิ่งที่จะหายถ้ากดรีเซ็ต — บอกในกล่องยืนยัน
  const resetWhat = [
    dynImages.length + (file ? 1 : 0) ? `รูป ${dynImages.length + (file ? 1 : 0)} รูป` : "",
    dynVideos.length ? `คลิป ${dynVideos.length} คลิป` : "",
    interests.length ? `ความสนใจ ${interests.length} รายการ` : "",
  ].filter(Boolean);
  const savedLabel = savedAt
    ? new Date(savedAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })
    : null;

  return (
    <div className="create-grid">
      <div className="card">
        <div className="c-head">
          <h3>สร้างโฆษณาใหม่</h3>
          <button type="button" className="btn" onClick={() => setAskReset(true)} disabled={busy}>↺ รีเซ็ต</button>
        </div>
        <p className="hint">กรอกครบแล้วกดปุ่มเดียว — ระบบสร้างแคมเปญ กลุ่มเป้าหมาย และโฆษณาให้ครบชุด (หยุดไว้ก่อนเสมอ)</p>
        <p className="c-hint">
          {savedLabel ? `💾 เก็บร่างไว้ในเครื่องนี้แล้ว (${savedLabel})` : "💾 กรอกแล้วเก็บร่างไว้ในเครื่องนี้ให้เอง"}
          {" "}— สลับหน้าหรือปิดเบราว์เซอร์แล้วกลับมาก็ยังอยู่ จนกว่าจะกดรีเซ็ต
        </p>
        {lostFiles.length > 0 && (
          <div className="c-warn">เก็บไฟล์นี้ไว้ไม่ได้ (พื้นที่เบราว์เซอร์ไม่พอ) — ถ้ารีเฟรชหรือปิดหน้าต้องใส่ใหม่: {lostFiles.join(", ")}</div>
        )}
        {askReset && (
          <div className="c-confirm" role="alertdialog" aria-label="ยืนยันรีเซ็ตฟอร์ม">
            <b>ล้างทุกช่อง{resetWhat.length ? ` รวม${resetWhat.join("และ")}` : ""}?</b>
            <div>ร่างที่เก็บไว้ในเครื่องนี้จะถูกลบด้วย กู้คืนไม่ได้ · ผู้สร้างที่เลือกไว้ ({AGENTS.find((a) => a.id === agent)?.label}) คงเดิม</div>
            <div className="c-actions">
              <button className="btn" onClick={() => setAskReset(false)}>ยกเลิก</button>
              <button className="btn primary" onClick={reset}>ล้างเลย</button>
            </div>
          </div>
        )}

        <div className="c-label">สร้างในนาม</div>
        {statusErr && <div className="msg bad">เช็คสถานะไม่ได้: {statusErr} <button className="btn" onClick={loadStatus}>ลองใหม่</button></div>}
        <div className="c-seg">
          {AGENTS.map((a) => {
            const st = status?.find((s) => s.agent === a.id);
            const off = !st?.configured;
            return (
              <button key={a.id} type="button" className={`c-opt ${agent === a.id ? "on" : ""}`} disabled={off}
                title={off ? st?.reason ?? "กำลังเช็คสถานะ…" : undefined}
                onClick={() => { if (a.id !== agent) { setAgent(a.id); setPageId(""); } }}>
                <b><span className="c-dot" style={{ background: a.color }} />{a.label}
                  {!status && <span className="c-tag wait">กำลังเช็ค…</span>}
                  {status && off && <span className="c-tag">ยังไม่ตั้งค่า</span>}
                  {st?.quota_full && <span className="c-tag">ครบโควตาวันนี้</span>}</b>
                <span>ชื่อขึ้นต้น {a.prefix}</span>
              </button>
            );
          })}
        </div>

        {cur?.configured && (<>
          <div className="c-label c-row-h">
            <span>ยิงในนามเพจ</span>
            <button type="button" className="btn" onClick={loadStatus} disabled={busy}>↻ โหลดเพจใหม่</button>
          </div>
          {cur.pages_error && <div className="msg bad">อ่านรายการเพจไม่ได้: {cur.pages_error} — ใช้เพจประจำ agent ไปก่อน</div>}
          <div className="c-pages" role="radiogroup" aria-label="เพจที่จะยิงโฆษณา">
            {pages.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === page?.id}
                className={`c-page ${p.id === page?.id ? "on" : ""}`} onClick={() => setPageId(p.id)}>
                <span className="c-radio" />
                {p.picture ? <img className="c-page-av" src={p.picture} alt="" /> : <span className="c-page-av">{p.name.slice(0, 1)}</span>}
                <span className="c-page-t">
                  <b>{p.name}{p.id === cur.default_page_id && <span className="c-tag ok">เพจประจำ {AGENTS.find((a) => a.id === agent)?.label}</span>}</b>
                  <small>{p.followers != null ? `ผู้ติดตาม ${p.followers.toLocaleString()}` : `เลขเพจ ${p.id}`}{p.business ? ` · ${p.business}` : ""}</small>
                </span>
              </button>
            ))}
          </div>
          {!cur.pages_error && cur.default_page_id && !pages.some((p) => p.id === cur.default_page_id) && (
            <div className="c-warn">เพจประจำ agent ({cur.default_page_id}) ไม่อยู่ในรายการที่ Token ลงโฆษณาได้ — เลือกเพจจากรายการ หรือแก้เพจประจำในหน้าเชื่อมต่อ API</div>
          )}
          <div className="c-hint">เพจที่ไม่อยู่ในรายการ → แชร์เพจให้ system user ใน Business Settings ก่อน แล้วกด ↻ โหลดเพจใหม่ · เปลี่ยนเพจแล้ว รูปปกเพจ · Live ที่นัดไว้ · ปลายทางแชท เปลี่ยนตาม</div>
        </>)}

        <div className="c-label">ชนิดโฆษณา</div>
        <div className="c-seg">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={`c-opt ${k.id === "LIVE" ? "c-opt-live" : ""} ${kind === k.id ? "on" : ""}`} onClick={() => pickKind(k.id)}>
              <b>{k.icon} {k.label}</b><span>{k.hint}</span>
            </button>
          ))}
        </div>

        {isLive && (<>
          <div className="c-label c-row-h">
            <span>Live ที่นัดไว้บนเพจ <small className="c-hint">(ดึงจากเพจ{pageName ? ` ${pageName}` : ""} อัตโนมัติ)</small></span>
            <button type="button" className="btn" onClick={loadLives} disabled={livesBusy || !cur?.configured}>{livesBusy ? "กำลังโหลด…" : "↻ โหลดใหม่"}</button>
          </div>
          {livesErr && <div className="msg bad">โหลดรายการ Live ไม่ได้: {livesErr}</div>}
          {!lives && !livesErr && <div className="c-hint">{cur?.configured ? "กำลังโหลดรายการ Live…" : "เลือกผู้สร้างที่ตั้งค่าแล้วก่อน"}</div>}
          {lives?.length === 0 && (
            <div className="c-hint"><span className="c-bad">✖ ยังไม่มี Live ที่นัดไว้ล่วงหน้าบนเพจ</span> — ตั้ง Live ล่วงหน้าที่เพจก่อน (Live Producer → ตั้งเวลา) แล้วกด ↻ โหลดใหม่</div>
          )}
          <div className="c-lives" role="radiogroup" aria-label="Live ที่นัดไว้">
            {lives?.map((l) => {
              const left = Date.parse(l.start_time) - now;
              const soon = !!liveOpt && left < liveOpt.lead_hours * 3600_000;
              return (
                <button key={l.id} type="button" role="radio" aria-checked={l.id === liveId}
                  className={`c-live ${l.id === liveId ? "on" : ""}`} onClick={() => setLiveId(l.id)}>
                  <span className="c-live-dot" />
                  <span className="c-live-t"><b>{l.name}</b><small>{fmtLive(l.start_time)} · {fmtLeft(left)}</small></span>
                  <span className={`c-live-pill ${soon ? "soon" : ""}`}>{soon ? "⚠ ใกล้เริ่ม" : "นัดไว้"}</span>
                </button>
              );
            })}
          </div>
          {liveSoon && liveOpt && <div className="c-warn">⚠ Live นี้เริ่มในไม่ถึง {liveOpt.lead_hours} ชม. — Meta แนะนำให้ตั้งโฆษณาเสร็จก่อนอย่างน้อย {liveOpt.lead_hours} ชม. อาจตรวจโฆษณาไม่ทัน</div>}
        </>)}

        <div className={`c-row ${isLive ? "c-row-live" : ""}`}>
          <div className="field"><label htmlFor="c-name">ชื่อแคมเปญ</label>
            <input id="c-name" className="input" value={name} maxLength={80} placeholder={isLive ? "เช่น แคมเปญการรับรู้ใหม่-Live สด" : "เช่น โปรลดราคา พ.ย."} onChange={(e) => setName(e.target.value)} /></div>
          {isLive && (
            <div className="field c-hours"><label htmlFor="c-hours">Live ยาว (ชม.)</label>
              <select id="c-hours" className="input" value={hours} onChange={(e) => pickHours(Number(e.target.value))}>
                {hourChoices.map((h) => <option key={h} value={h}>{h}</option>)}
              </select></div>
          )}
          <div className="field"><label htmlFor="c-budget">{isLive ? "งบรวมทั้ง Live (บาท)" : "งบต่อวัน (บาท)"}</label>
            <input id="c-budget" className="input" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ""))} />
            <small className="c-hint">สูงสุด {maxBudget.toLocaleString()} บาท{isLive ? "" : "/วัน"}</small></div>
        </div>
        {isLive && liveOpt && (
          <small className="c-hint">คิดให้ {liveOpt.thb_per_hour.toLocaleString()} บาท/ชม. แก้ตัวเลขเองได้ · ใช้ &quot;งบรวม&quot; เพราะงบรายวัน Meta บังคับให้เปิดอย่างน้อย 24 ชม.</small>
        )}

        {isLive ? (<div className="field"><label htmlFor="c-text">ข้อความชวนดู Live <small className="c-hint">(ไม่บังคับ — เป็นข้อความของโฆษณารูป และให้ AI ใช้คิดกลุ่มเป้าหมาย · ว่าง = แอปเขียนชื่อ+เวลา Live ให้)</small></label>
          <textarea id="c-text" className="input c-text" value={text} maxLength={2000} placeholder="เช่น Live แนะนำระบบ ERP + AI สำหรับโรงงาน ถาม-ตอบสด" onChange={(e) => setText(e.target.value)} /></div>)
        : !isDyn && (<div className="field"><label htmlFor="c-text">ข้อความโฆษณา</label>
          <textarea id="c-text" className="input c-text" value={text} maxLength={2000} placeholder="เช่น ทักแชทสอบถามสินค้าได้เลยครับ" onChange={(e) => setText(e.target.value)} /></div>)}

        {kind === "WEBSITE" && (
          <div className="field"><label htmlFor="c-link">ลิงก์เว็บไซต์ปลายทาง</label>
            <input id="c-link" className="input" value={link} placeholder="https://..." onChange={(e) => setLink(e.target.value)} /></div>
        )}

        {crOpt && !isLive && (
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
        <div className="c-label">{isLive ? "รูปโฆษณาชวนดู Live" : "รูปโฆษณา"}</div>
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
        {isLive && <small className="c-hint">แอปสร้างโฆษณารูปนี้ให้ทันที (หยุดไว้) · คนกด &quot;ดูเพิ่มเติม&quot; → หน้ากิจกรรม Live · ตอน Live ออกอากาศ กดปุ่ม 🔴 ในการ์ดผลลัพธ์เพื่อเพิ่มโฆษณาคลิป Live</small>}
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
              <InterestPicker key={pickerKey} agent={agent} agents={status} interests={interests} setInterests={setInterests}
                max={audOpt.max_interests} kwRef={kwInput}
                onAudience={(a) => { setAgeMin(a.age_min); setAgeMax(a.age_max); setLangs(a.languages); }}
                copyHint={isLive ? "ชื่อ Live + เกี่ยวกับ Live นี้" : `ข้อความหลัก${isDyn ? " + พาดหัว" : ""}${kind === "WEBSITE" ? " + ลิงก์" : ""}`}
                copy={() => isLive ? { texts: [text.trim()].filter(Boolean), titles: [live?.name ?? ""].filter(Boolean), link_url: "" }
                  : ({ texts: isDyn ? filledTexts : [text.trim()].filter(Boolean), titles: isDyn ? filledTitles : [],
                  link_url: kind === "WEBSITE" ? link.trim() : "" })} />
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
        {isLive ? (
          <div className={`c-hint c-sched ${live ? "ok" : "bad"}`}>
            {live && liveStart !== null
              ? `✔ ${fmtLive(live.start_time).replace(" น.", "")} → ${fmtClock(new Date(liveStart + hours * 3600_000))} น. (${hours} ชม. ตรงกับ Live)${budgetNum > 0 ? ` · งบรวม ฿${budgetNum.toLocaleString()}` : ""}`
              : "✖ เลือก Live ก่อน — เวลาเผยแพร่ตั้งตามเวลา Live ให้เอง"}
          </div>
        ) : (<>
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
        </>)}

        <div className="c-safe">{isLive
          ? <>⏸ สร้างแบบ <b>หยุดไว้</b> · เป้าหมาย: เข้าถึงคนให้มากที่สุด · ความถี่ตามค่าเริ่มต้นของ Meta · ตำแหน่ง Advantage+ — แอปสร้างแคมเปญและชุดโฆษณา ส่วนการผูก Live ทำต่อใน Ads Manager ~1 นาที</>
          : <>⏸ โฆษณาจะถูกสร้างแบบ <b>หยุดไว้</b> — ยังไม่เสียเงินจนกว่าคุณจะไปกดเปิดใน Ads Manager</>}</div>

        <div className="c-actions">
          <button className="btn primary c-submit" disabled={problems.length > 0 || busy} onClick={() => submit()}>
            {busy ? (isDyn && dynVideos.length ? "กำลังอัปโหลดและรอ Meta ประมวลผลคลิป… (อาจนานหลายนาที)" : "กำลังสร้าง… (ประมาณ 20 วินาที)") : isLive ? "🔴 สร้างแคมเปญ Live" : "สร้างโฆษณา"}
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
            {result.page && <div className="c-hint">📄 เพจ: <b>{result.page.name}</b></div>}
            {result.success && result.live_next && (
              <>
              {result.adset_id && <LiveOnAirButton agent={agent} adsetId={result.adset_id} liveName={result.live_next.live_name} pageId={result.page?.id} />}
              <details className="c-next">
                <summary>ทางสำรอง: ผูก Live เองใน Ads Manager</summary>
                {result.live_next.adset_name && (
                  <div className="c-target">
                    🎯 ชุดที่ต้องเปิด: <b>{result.live_next.adset_name}</b>
                    {result.adset_id && <span className="c-target-id"> · เลข {result.adset_id}</span>}
                    <small>⚠ ถ้า Ads Manager ขึ้นป้าย &quot;เป็นฉบับร่าง&quot; หรือชื่อไม่ตรงนี้ = เปิดผิดชุด (ฉบับร่างที่สร้างเองใน Ads Manager ไม่มีความสนใจจากแอป)</small>
                  </div>
                )}
                <ol>{result.live_next.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                <div className="c-actions">
                  <a className="btn primary" href={result.live_next.adset_url} target="_blank" rel="noreferrer">↗ เปิดชุดโฆษณาใน Ads Manager</a>
                  {result.live_next.text && (
                    <button className="btn" onClick={() => copyLiveText(result.live_next!.text)}>{copied ? "✔ คัดลอกแล้ว" : "📋 คัดลอกข้อความโฆษณา"}</button>
                  )}
                </div>
                <small className="c-hint">⏰ ตั้งโฆษณาให้เสร็จก่อน Live &quot;{result.live_next.live_name}&quot; ({fmtLive(result.live_next.start_time)}) อย่างน้อย {result.live_next.lead_hours} ชม. และเริ่ม Live จากรายการที่นัดไว้ใน Live Producer โฆษณาถึงจะวิ่ง</small>
              </details>
              </>
            )}
            {result.success && (
              <div className="c-actions">
                {result.ads_manager_url && <a className="btn" href={result.ads_manager_url} target="_blank" rel="noreferrer">เปิดใน Ads Manager ↗</a>}
                {result.adset_id && <button className="btn" onClick={() => setEditAdset(true)}>＋ เพิ่มความสนใจให้ Ad Set นี้</button>}
                <button className="btn" onClick={() => { setResult(null); setEditAdset(false); }}
                  title="ข้อมูลในฟอร์มยังอยู่ครบ — แก้ชื่อหรืองบแล้วกดสร้างใหม่ได้เลย">สร้างอีกชุด</button>
                {result.dashboard_updated && <span className="c-hint">อัปเดตหน้าภาพรวมแล้ว</span>}
              </div>
            )}
          </div>
        )}
        {editAdset && result?.adset_id && (
          <AdsetInterests agent={agent} adsetId={result.adset_id} agents={status} onClose={() => setEditAdset(false)} />
        )}
      </div>

      <div className="card">
        <h3>ตัวอย่างโฆษณา</h3>
        <p className="hint">หน้าตาโดยประมาณบนฟีด Facebook — เปลี่ยนตามที่กรอกทันที</p>
        <div className="fbp">
          <div className="fbp-h">{page?.picture ? <img className="fbp-av" src={page.picture} alt="" /> : <div className="fbp-av" />}<div><b>{pageName ?? "เพจของคุณ"}</b><small>ได้รับการสนับสนุน</small></div></div>
          <p className="fbp-text">{(isDyn ? combo?.t : text) || <span className="fbp-ph">ข้อความโฆษณาจะแสดงตรงนี้</span>}</p>
          {isLive && previewImage
            // eslint-disable-next-line @next/next/no-img-element
            ? <img className="fbp-img" src={previewImage} alt="รูปโฆษณาชวนดู Live" />
            : isLive
            ? <div className="fbp-img fbp-live"><span className="fbp-live-b">🔴 ถ่ายทอดสด</span><b>{live?.name ?? "Live ที่นัดไว้"}</b>
                {live && <small>{fmtLive(live.start_time)}</small>}</div>
            : isDyn
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
            <div><small>{kind === "MESSENGER" ? "MESSENGER" : isLive ? "FACEBOOK · กิจกรรม LIVE" : (link.replace(/^https?:\/\//, "").split("/")[0] || "เว็บไซต์ของคุณ").toUpperCase()}</small>
              <b>{(isLive && live?.name) || (isDyn && combo?.h) || name || "ชื่อแคมเปญ"}</b></div>
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
        <p className="c-hint" style={{ textAlign: "center" }}>{isLive ? `โฆษณารูปชวนดู Live · รูปที่ใช้: ${imageSource} · คลิป Live เพิ่มได้ตอนออกอากาศ` : `${isDyn ? "ชิ้นงาน" : "รูปที่ใช้"}: ${imageSource}`}</p>

        <div className="c-checks">
          <b>เช็คก่อนสร้าง</b>
          {!status && <div className="c-hint">กำลังเช็คสถานะ…</div>}
          {cur?.checks.filter((c) => c.key !== "budget").map((c) => (
            <div key={c.key} className={c.ok ? "ok" : "bad"}>{c.ok ? "✔" : "✖"} {c.label} — {c.detail}</div>
          ))}
          {status && (
            <div className={budgetNum > 0 && budgetNum <= maxBudget ? "ok" : "bad"}>
              {budgetNum > 0 && budgetNum <= maxBudget ? "✔" : "✖"} {isLive ? "งบรวมทั้ง Live" : "งบต่อวัน"} — {budgetNum ? budgetNum.toLocaleString() : 0} / เพดาน {maxBudget.toLocaleString()} บาท
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
