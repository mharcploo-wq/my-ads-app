"use client";
import { useCallback, useEffect, useState } from "react";
import PlatformChart, { PLATFORM_COLOR } from "@/components/PlatformChart";
import { fmt } from "@/lib/calc";
import type { BestWorst, BigNumber, Block, BriefingResult, BriefingSchedule, BriefingSection, PageStat, Pick, PlatformSeries } from "@/lib/briefingTypes";

/** Daily Briefing — เปิดตอนเช้า อ่านจบใน 1 นาที · ตัวเลขจริงของ "เมื่อวาน" จาก Meta ทุกพอร์ต
 *  หน้าเว็บแค่แสดง (คำนวณ/ตัดสินที่ server) · ดึงไม่ได้ = บอกว่าดึงไม่ได้ ไม่เดา */

const show = (unit: "baht" | "count", v: number | null) =>
  v === null ? "—" : unit === "baht" ? fmt.baht(v) : v % 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : fmt.int(v);

function Compare({ label, now, base, unit, lowerIsBetter, neutral }: {
  label: string; now: number | null; base: number | null; unit: "baht" | "count"; lowerIsBetter: boolean; neutral?: boolean;
}) {
  let mark: React.ReactNode;
  if (now === null || base === null) mark = <span className="muted">ไม่มีตัวเลขให้เทียบ</span>;
  else if (Math.abs(now - base) < 1e-9) mark = <span className="muted">เท่าเดิม</span>;
  else if (base === 0) mark = <span className="muted">จาก 0</span>;
  else {
    const pct = ((now - base) / base) * 100;
    const up = pct >= 0, good = lowerIsBetter ? !up : up;
    const color = neutral || Math.abs(pct) < 0.05 ? "var(--text-secondary)" : good ? "#6fd46f" : "#ff8a8a";
    mark = <span style={{ color }}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%</span>;
  }
  return (
    <div className="brief-cmp">
      <span className="muted">{label} {show(unit, base)}</span> {mark}
    </div>
  );
}

/** ค่าของแพลตฟอร์มตามตัวเลขใหญ่ (spend / results / cpr) */
const seriesOf = (p: PlatformSeries, key: BigNumber["key"]): (number | null)[] => (key === "cpr" ? p.cpr : p[key]);

function Big({ b, platforms }: { b: BigNumber; platforms: PlatformSeries[] }) {
  return (
    <div className="kpi brief-big">
      <div className="label">{b.label}</div>
      <div className="value">{show(b.unit, b.now)}</div>
      <Compare label="วันก่อน" now={b.now} base={b.prev} unit={b.unit} lowerIsBetter={b.lowerIsBetter} neutral={b.key === "spend"} />
      <Compare label="เฉลี่ย 7 วัน" now={b.now} base={b.avg7} unit={b.unit} lowerIsBetter={b.lowerIsBetter} neutral={b.key === "spend"} />
      <div className="brief-note">{b.note}</div>
      <div className="brief-split">
        {platforms.map((p) => {
          const v = seriesOf(p, b.key);
          return <span key={p.key}><span className="swatch" style={{ background: PLATFORM_COLOR[p.key] }} />{p.label} {show(b.unit, v[v.length - 1])}</span>;
        })}
      </div>
    </div>
  );
}

function PickRow({ tone, p }: { tone: "best" | "worst"; p: Pick }) {
  return (
    <div className="brief-pick">
      <span className={`pill ${tone === "best" ? "ok" : "bad"}`}>{tone === "best" ? "ดีสุด" : "แย่สุด"}</span>
      <div>
        <a href={p.link} target="_blank" rel="noreferrer">{p.name}</a>
        <div className="muted">{p.detail}</div>
      </div>
    </div>
  );
}

function Picks({ title, block }: { title: string; block: Block<BestWorst> }) {
  return (
    <div className="card brief-box">
      <h3>{title}</h3>
      {!block.ok ? (
        <div className="brief-miss">⚠ {block.error}</div>
      ) : (
        <>
          {block.best && <PickRow tone="best" p={block.best} />}
          {block.worst && <PickRow tone="worst" p={block.worst} />}
          {block.note && <div className="muted">{block.note}</div>}
        </>
      )}
    </div>
  );
}

function Stat({ s }: { s: PageStat }) {
  return (
    <div className="brief-stat">
      <div className="muted">{s.label}</div>
      <div className="num brief-stat-v">{show("count", s.now)}</div>
      <Compare label="วันก่อน" now={s.now} base={s.prev} unit="count" lowerIsBetter={false} />
      <Compare label="เฉลี่ย 7 วัน" now={s.now} base={s.avg7} unit="count" lowerIsBetter={false} />
    </div>
  );
}

/** ช่องเลือกเพจของพอร์ต — รายการมาจาก token ของพอร์ตนั้น (server ส่งมา) · มีผลแค่หน้านี้ */
function PagePicker({ s, busy, onPick }: { s: BriefingSection; busy: boolean; onPick: (account: string, page: string) => void }) {
  if (!s.pageId || !s.pages?.length) return null; // snapshot รุ่นเก่า / อ่านรายการเพจไม่ได้
  const list = s.pages.some((p) => p.id === s.pageId) ? s.pages : [{ id: s.pageId, name: s.page?.name ?? s.pageId }, ...s.pages];
  return (
    <label className="brief-page-pick">
      เพจ
      <select value={s.pageId} disabled={busy} onChange={(e) => onPick(s.account, e.target.value)} aria-label="เลือกเพจที่จะแสดง">
        {list.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === s.defaultPage ? " (เพจประจำ Agent)" : ""}</option>)}
      </select>
      {busy && <span className="brief-page-busy">กำลังดึงข้อมูลเพจ…</span>}
    </label>
  );
}

function Section({ s, picking, pickErr, onPick }: { s: BriefingSection; picking: boolean; pickErr: string | null; onPick: (account: string, page: string) => void }) {
  return (
    <section className="brief-section">
      <div className="brief-head">
        {s.page?.picture
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={s.page.picture} alt="" width={44} height={44} />
          : <div className="logo">f</div>}
        <div>
          <h2>{s.page ? <a href={s.page.link} target="_blank" rel="noreferrer">{s.page.name}</a> : "อ่านชื่อเพจไม่ได้"}</h2>
          <div className="muted">บัญชีโฆษณา {s.accountName} · {s.account}</div>
        </div>
        <PagePicker s={s} busy={picking} onPick={onPick} />
      </div>
      {s.pageWarn && <div className="brief-page-warn">⚠ {s.pageWarn}</div>}
      {pickErr && <div className="brief-page-warn">⚠ เปลี่ยนเพจไม่สำเร็จ — {pickErr}</div>}

      {s.ads.ok
        ? <>
            <div className="kpis num brief-bigs">{s.ads.big.map((b) => <Big key={b.key} b={b} platforms={s.ads.ok ? s.ads.platforms : []} />)}</div>
            <div className="brief-charts">
              {s.ads.big.map((b) => (
                <div key={b.key} className="card">
                  <h3>{b.label.replace(/ \(.*\)$/, "")} · 8 วัน</h3>
                  <PlatformChart days={s.ads.ok ? s.ads.days : []} unit={b.unit}
                    lines={(s.ads.ok ? s.ads.platforms : []).map((p) => ({ key: p.key, label: p.label, values: seriesOf(p, b.key) }))} />
                </div>
              ))}
            </div>
          </>
        : <div className="card brief-miss">⚠ ตัวเลขโฆษณา: {s.ads.error}</div>}

      <h3 className="brief-sub">ดีสุดและแย่สุดของเมื่อวาน</h3>
      <div className="brief-grid">
        <Picks title="โฆษณา" block={s.adPicks} />
        <Picks title="โพสต์เพจ Facebook" block={s.posts} />
        <Picks title={s.instagram.ok ? `Instagram @${s.instagram.username}` : "Instagram"} block={s.instagram} />
      </div>

      <h3 className="brief-sub">เพจ Facebook เมื่อวาน</h3>
      {s.pageStats.ok ? (
        <div className="card">
          <div className="brief-stats">{s.pageStats.rows.map((r) => <Stat key={r.label} s={r} />)}</div>
          <div className="brief-note">{s.pageStats.note}</div>
        </div>
      ) : <div className="card brief-miss">⚠ {s.pageStats.error}</div>}

      <h3 className="brief-sub">วันนี้ต้องแก้อะไร</h3>
      <div className="card">
        {s.fixes.length ? (
          <ol className="brief-fixes">
            {s.fixes.map((f, i) => <li key={i}>{f.text}<div className="muted">ดูจาก: {f.from}</div></li>)}
          </ol>
        ) : <div className="muted">ตัวเลขเมื่อวานไม่มีเรื่องที่ต้องแก้</div>}
      </div>
    </section>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = ["00", "15", "30", "45"];
const BKK = "Asia/Bangkok";
const bkkDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: BKK });
const bkkTime = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: BKK, hour: "2-digit", minute: "2-digit", hour12: false });
/** "วันนี้ 08:00" · "พรุ่งนี้ 08:00" · "เมื่อวาน 08:00" · วันอื่น = วันที่ */
function when(iso: string) {
  const d = new Date(iso), now = new Date();
  const diff = Math.round((Date.parse(bkkDay(d)) - Date.parse(bkkDay(now))) / 86_400_000);
  const day = diff === 0 ? "วันนี้" : diff === 1 ? "พรุ่งนี้" : diff === -1 ? "เมื่อวาน" : fmt.dateShort(bkkDay(d));
  return `${day} ${bkkTime(d)}`;
}

/** แถบตั้งเวลาอัปเดตอัตโนมัติ (ใต้หัวหน้า) — เวลา 24 ชม. เวลาไทย · ทำงานเมื่อแอปเปิดอยู่ */
function ScheduleStrip({ s, saving, onChange }: {
  s: BriefingSchedule | null; saving: boolean; onChange: (p: { enabled?: boolean; time?: string }) => void;
}) {
  if (!s) return <div className="brief-sched"><span className="muted">กำลังอ่านการตั้งเวลา…</span></div>;
  const [hh, mm] = s.time.split(":");
  const minutes = MINUTES.includes(mm) ? MINUTES : [...MINUTES, mm].sort();
  return (
    <div className="brief-sched">
      <label>⏰ อัปเดตอัตโนมัติทุกวัน เวลา
        <select aria-label="ชั่วโมง" value={hh} disabled={saving} onChange={(e) => onChange({ time: `${e.target.value}:${mm}` })}>
          {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>:
        <select aria-label="นาที" value={mm} disabled={saving} onChange={(e) => onChange({ time: `${hh}:${e.target.value}` })}>
          {minutes.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        น.
      </label>
      <span className="brief-tog-wrap">
        <button className="brief-tog" role="switch" aria-checked={s.enabled} aria-label="เปิด/ปิดอัปเดตอัตโนมัติ"
          disabled={saving} onClick={() => onChange({ enabled: !s.enabled })} />
        {s.enabled ? "เปิดอยู่" : "ปิดอยู่"}
      </span>
      <span>อัปเดตล่าสุด {s.lastAuto ? <b className="ok">{when(s.lastAuto)}</b> : <b>ยังไม่เคย</b>} (อัตโนมัติ)</span>
      {s.running
        ? <span><b>กำลังอัปเดต…</b></span>
        : <span>รอบถัดไป <b>{s.next ? when(s.next) : "— ปิดอยู่ ไม่อัปเดตเอง"}</b></span>}
      {s.lastError && <span className="bad">⚠ รอบล่าสุดไม่สำเร็จ: {s.lastError}</span>}
      <span className="spacer" />
      <span className="muted brief-sched-note">ทำงานเมื่อแอปเปิดอยู่ · ถ้าเปิดแอปหลังเวลานี้ จะอัปเดตให้ทันที</span>
    </div>
  );
}

export default function BriefingPage() {
  const [data, setData] = useState<BriefingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sched, setSched] = useState<BriefingSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [schedErr, setSchedErr] = useState<string | null>(null);

  const load = useCallback(async (fresh: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/briefing${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      setData(await r.json());
    } catch (e) {
      setData({ ok: false, error: `โหลดไม่สำเร็จ: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { load(false); }, [load]);

  const [picking, setPicking] = useState<string | null>(null);
  const [pickErr, setPickErr] = useState<{ account: string; msg: string } | null>(null);
  const pickPage = useCallback(async (account: string, page: string) => {
    setPicking(account);
    setPickErr(null);
    try {
      const r = (await (await fetch("/api/briefing/page", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account, page }),
      })).json()) as BriefingResult;
      if (r.ok) setData(r);
      else setPickErr({ account, msg: r.error });
    } catch (e) {
      setPickErr({ account, msg: (e as Error).message });
    } finally {
      setPicking(null);
    }
  }, []);

  const readSched = useCallback(async () => {
    try {
      const r = await (await fetch("/api/briefing/schedule", { cache: "no-store" })).json();
      if (r.ok) setSched(r.schedule);
    } catch { /* เซิร์ฟเวอร์ไม่ตอบ — รอบหน้าอ่านใหม่ */ }
  }, []);
  // อ่านสถานะทุก 30 วินาที — เปิดหน้าค้างไว้แล้วถึงเวลาอัปเดต จะเห็นข้อมูลชุดใหม่เอง
  useEffect(() => {
    readSched();
    const t = setInterval(readSched, 30_000);
    return () => clearInterval(t);
  }, [readSched]);
  const dataAt = data?.ok ? data.at : null;
  useEffect(() => {
    if (sched?.lastAuto && dataAt && Date.parse(sched.lastAuto) > Date.parse(dataAt) + 5_000) load(false);
  }, [sched?.lastAuto, dataAt, load]);

  const saveSched = async (p: { enabled?: boolean; time?: string }) => {
    setSaving(true);
    setSchedErr(null);
    try {
      const r = await (await fetch("/api/briefing/schedule", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p),
      })).json();
      if (r.ok) setSched(r.schedule); else setSchedErr(r.error);
    } catch (e) {
      setSchedErr(`บันทึกเวลาไม่สำเร็จ: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="topbar brief-top">
        <div className="wrap">
          <div className="logo">☀</div>
          <div className="brand">
            <h1>Daily Briefing</h1>
            <p>{data?.ok ? `ข้อมูลของเมื่อวาน · ${fmt.dateLong(data.yesterday)}` : "ข้อมูลของเมื่อวาน"}</p>
          </div>
          <span className="spacer" />
          {data?.ok && <span className="muted brief-at">ดึงจาก Meta {fmt.ago(data.at)}</span>}
          <button className="btn" onClick={() => load(true)} disabled={busy}>{busy ? "กำลังดึง…" : "↻ ดึงใหม่"}</button>
          <a className="btn" href="/">กลับ Ads Control</a>
        </div>
        <div className="wrap brief-sched-row"><ScheduleStrip s={sched} saving={saving} onChange={saveSched} /></div>
      </header>
      <main className="wrap">
        {schedErr && <div className="banner">⚠ {schedErr}</div>}
        {!data && <div className="empty">กำลังดึงข้อมูลเมื่อวานจาก Meta…</div>}
        {data && !data.ok && <div className="banner">⚠ {data.error}</div>}
        {data?.ok && data.stale && <div className="banner">⚠ ดึงใหม่ไม่ได้ — แสดงชุดเดิม: {data.stale}</div>}
        {data?.ok && data.sections.map((s) => (
          <Section key={s.account} s={s} picking={picking === s.account} pickErr={pickErr?.account === s.account ? pickErr.msg : null} onPick={pickPage} />
        ))}
      </main>
    </>
  );
}
