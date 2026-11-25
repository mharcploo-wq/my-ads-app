"use client";
import { useCallback, useEffect, useState } from "react";
import { fmt } from "@/lib/calc";
import type { BestWorst, BigNumber, Block, BriefingResult, BriefingSection, PageStat, Pick } from "@/lib/briefingTypes";

/** Daily Briefing — เปิดตอนเช้า อ่านจบใน 1 นาที · ตัวเลขจริงของ "เมื่อวาน" จาก Meta ทุกพอร์ต
 *  หน้าเว็บแค่แสดง (คำนวณ/ตัดสินที่ server) · ดึงไม่ได้ = บอกว่าดึงไม่ได้ ไม่เดา */

const show = (unit: "baht" | "count", v: number | null) =>
  v === null ? "—" : unit === "baht" ? fmt.baht(v) : v % 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : fmt.int(v);

function Compare({ label, now, base, unit, lowerIsBetter, neutral }: {
  label: string; now: number | null; base: number | null; unit: "baht" | "count"; lowerIsBetter: boolean; neutral?: boolean;
}) {
  let mark: React.ReactNode;
  if (now === null || base === null) mark = <span className="muted">ไม่มีตัวเลขให้เทียบ</span>;
  else if (base === 0 && now === 0) mark = <span className="muted">เท่าเดิม</span>;
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

function Big({ b }: { b: BigNumber }) {
  return (
    <div className="kpi brief-big">
      <div className="label">{b.label}</div>
      <div className="value">{show(b.unit, b.now)}</div>
      <Compare label="วันก่อน" now={b.now} base={b.prev} unit={b.unit} lowerIsBetter={b.lowerIsBetter} neutral={b.key === "spend"} />
      <Compare label="เฉลี่ย 7 วัน" now={b.now} base={b.avg7} unit={b.unit} lowerIsBetter={b.lowerIsBetter} neutral={b.key === "spend"} />
      <div className="brief-note">{b.note}</div>
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

function Section({ s }: { s: BriefingSection }) {
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
      </div>

      {s.ads.ok
        ? <div className="kpis num brief-bigs">{s.ads.big.map((b) => <Big key={b.key} b={b} />)}</div>
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

export default function BriefingPage() {
  const [data, setData] = useState<BriefingResult | null>(null);
  const [busy, setBusy] = useState(false);

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
      </header>
      <main className="wrap">
        {!data && <div className="empty">กำลังดึงข้อมูลเมื่อวานจาก Meta…</div>}
        {data && !data.ok && <div className="banner">⚠ {data.error}</div>}
        {data?.ok && data.stale && <div className="banner">⚠ ดึงใหม่ไม่ได้ — แสดงชุดเดิม: {data.stale}</div>}
        {data?.ok && data.sections.map((s) => <Section key={s.account} s={s} />)}
      </main>
    </>
  );
}
