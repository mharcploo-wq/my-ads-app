"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import InsightsTable, { useOpenRows } from "./InsightsTable";
import InsightsTrend from "./InsightsTrend";
import { fmt } from "@/lib/calc";
import {
  AiSummary, DailyPoint, DEFAULT_RANGE, InsightsData, InsightsResponse, Metrics, RANGES, RangeKey, SEV, Sev, WhoKey,
} from "@/lib/insightsTypes";
import { AGENTS, PREFIXES } from "@/lib/types";

const b2 = (v: number | null) => (v === null ? "—" : `฿${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const b0 = (v: number) => `฿${Math.round(v).toLocaleString("en-US")}`;
const int = (v: number) => Math.round(v).toLocaleString("en-US");

const WHO_LABEL: Record<WhoKey, string> = { all: "ทุกแคมเปญ", agent: "agent สร้าง", "CLD-": "Claude", "MANUS-": "Manus", "GPT-": "ChatGPT", human: "คนสร้าง" };
const WHO_ORDER: WhoKey[] = ["all", "agent", ...PREFIXES, "human"];

type MetricKey = "spend" | "results" | "link_clicks" | "ctr" | "cpm";
const METRIC: Record<MetricKey, { label: string; get: (d: DailyPoint) => number | null; fmt: (n: number) => string }> = {
  spend: { label: "ใช้ไป (บาท)", get: (d) => d.spend, fmt: (n) => b0(n) },
  results: { label: "ผลลัพธ์ (รวมทุกชนิด)", get: (d) => d.results, fmt: (n) => int(n) },
  link_clicks: { label: "คลิกลิงก์", get: (d) => d.link_clicks, fmt: (n) => int(n) },
  ctr: { label: "CTR ลิงก์ (%)", get: (d) => (d.impressions ? (d.link_clicks / d.impressions) * 100 : null), fmt: (n) => `${n.toFixed(2)}%` },
  cpm: { label: "CPM (บาท)", get: (d) => (d.impressions ? (d.spend / d.impressions) * 1000 : null), fmt: (n) => b0(n) },
};
const SEV_ORDER: Sev[] = ["critical", "serious", "warning", "info"];
const AGES = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
const GENDERS = [["female", "หญิง"], ["male", "ชาย"], ["unknown", "ไม่ระบุ"]] as const;
/** ฟ้าเฉดเดียว (sequential) — เข้ม = ใช้เงินมาก · ช่องแรกคือพื้นการ์ด */
const RAMP = ["var(--surface-2)", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7"];

function Delta({ now, prev, mode }: { now: number | null; prev: number | null; mode?: "inv" | "neutral" }) {
  if (now === null || prev === null || prev === 0) return <div className="delta">ไม่มีข้อมูลช่วงก่อนหน้า</div>;
  const pct = ((now - prev) / prev) * 100, up = pct >= 0;
  const good = mode === "inv" ? !up : up;
  return (
    <div className="delta">
      <span style={{ color: mode === "neutral" ? "var(--text-secondary)" : good ? "#6fd46f" : "#ff8a8a" }}>{up ? "▲" : "▼"} {Math.abs(pct) >= 1000 ? int(Math.abs(pct)) : Math.abs(pct).toFixed(0)}%</span> เทียบช่วงก่อน
    </div>
  );
}

/** แท็บ "วิเคราะห์โฆษณา" — ทั้งบัญชี (อ่านอย่างเดียว) + คำแนะนำ + ปุ่ม ✨ ให้ Claude สรุป */
export default function InsightsPanel() {
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [who, setWho] = useState<WhoKey>("all");
  const [data, setData] = useState<InsightsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<MetricKey>("spend");
  const [showRules, setShowRules] = useState(false);
  const [ai, setAi] = useState<{ busy: boolean; res: AiSummary | null; err: string | null; key: string }>({ busy: false, res: null, err: null, key: "" });
  const rows = useOpenRows();

  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/insights?range=${range}&who=${encodeURIComponent(who)}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
      const j = (await r.json()) as InsightsResponse;
      if (!j.ok) throw new Error(j.error);
      setData(j); setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [range, who]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { rows.reset(); }, [range, who]);   // eslint-disable-line react-hooks/exhaustive-deps

  const askAi = async () => {
    const key = `${range}|${who}`;
    setAi({ busy: true, res: null, err: null, key });
    try {
      const r = await fetch("/api/insights/summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ range, who }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      const res = j.result as AiSummary;
      setAi({ busy: false, res: res.success ? res : null, err: res.success ? null : res.error ?? "Claude ตอบไม่สำเร็จ", key });
    } catch (e) {
      setAi({ busy: false, res: null, err: (e as Error).message, key });
    }
  };

  const view = data && data.range === range && data.who === who ? data : null;
  const trend = useMemo(() => view ? { dates: view.daily.map((d) => d.date), values: view.daily.map(METRIC[metric].get) } : null, [view, metric]);
  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? range;
  const aiHere = ai.key === `${range}|${who}`;

  return (
    <>
      <div className="filters">
        <div className="seg" role="group" aria-label="ช่วงเวลา">
          {RANGES.map((r) => <button key={r.key} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>)}
        </div>
        <div className="seg" role="group" aria-label="กรองแคมเปญ">
          {WHO_ORDER.map((k) => (
            <button key={k} aria-pressed={who === k} onClick={() => setWho(k)}>
              {k in AGENTS && <span className="swatch" style={{ background: AGENTS[k as keyof typeof AGENTS].color }} />}{WHO_LABEL[k]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="in-meta">
          {view && <>บัญชี <b>{view.account.name}</b> · {view.account.currency}</>}
          {view?.period && <> · {fmt.dateShort(view.period.since)} – {fmt.dateShort(view.period.until)}</>}
          {view?.prevPeriod && <> · เทียบ {fmt.dateShort(view.prevPeriod.since)} – {fmt.dateShort(view.prevPeriod.until)}</>}
          {view && <> · ดึงเมื่อ {new Date(view.fetched_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}</>}
        </span>
        <button className="btn" onClick={() => load(true)} disabled={busy}>{busy ? "กำลังดึง…" : "↻ ดึงใหม่"}</button>
      </div>

      {err && <div className="banner in-err">✕ ดึงข้อมูลจาก Meta ไม่ได้: {err}</div>}
      {view?.stale && <div className="banner in-err">✕ ดึงข้อมูลใหม่จาก Meta ไม่ได้: {view.stale}<br /><span>กำลังแสดงข้อมูลชุดเดิม (ดึงเมื่อ {new Date(view.fetched_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}) · ไม่มีอะไรถูกแก้บน Meta</span></div>}
      {!view && !err && <div className="empty">กำลังดึงข้อมูลจาก Meta…</div>}

      {view && !view.period && (
        <div className="card empty" style={{ marginTop: 16 }}>
          ช่วง &quot;{rangeLabel}&quot; ยังไม่มีค่าใช้จ่าย{who !== "all" && <> (ตัวกรอง: {WHO_LABEL[who]})</>} — แคมเปญตรงตัวกรอง {view.counts.campaigns} · เปิดอยู่ {view.counts.active}
          {view.idle.length > 0 && who !== "all" && who !== "human" && <div className="hint" style={{ marginTop: 6 }}>แคมเปญ: {view.idle.slice(0, 6).map((x) => x.name).join(", ")}{view.idle.length > 6 ? " …" : ""}</div>}
          <div className="hint" style={{ marginTop: 6 }}>{who !== "all" ? "ลองเลือก \"ทุกแคมเปญ\" หรือช่วงเวลาที่ยาวขึ้น" : "ลองเลือกช่วงเวลาที่ยาวขึ้น เช่น 30 วัน"}</div>
        </div>
      )}

      {view?.period && (
        <>
          <section className="kpis in-kpis num" aria-label="ตัวชี้วัดหลัก">
            <Kpi label="ใช้ไป" value={b2(view.total.spend)} d={<Delta now={view.total.spend} prev={view.prev?.spend ?? null} mode="neutral" />} />
            <Kpi label="การแสดงผล" value={int(view.total.impressions)} d={<Delta now={view.total.impressions} prev={view.prev?.impressions ?? null} />} />
            <Kpi label="การเข้าถึง" value={int(view.total.reach)} d={<Delta now={view.total.reach} prev={view.prev?.reach ?? null} />} />
            <Kpi label="คลิกลิงก์" value={int(view.total.link_clicks)} d={<Delta now={view.total.link_clicks} prev={view.prev?.link_clicks ?? null} />} />
            <Kpi label="CTR ลิงก์" value={`${view.total.link_ctr.toFixed(2)}%`} d={<Delta now={view.total.link_ctr} prev={view.prev?.link_ctr ?? null} />} />
            <Kpi label="CPM" value={b2(view.total.cpm)} d={<Delta now={view.total.cpm} prev={view.prev?.cpm ?? null} mode="inv" />} />
            <Kpi label="ความถี่เฉลี่ย" value={view.total.frequency.toFixed(2)} d={<div className="delta">คนหนึ่งเห็นกี่ครั้ง · เกิน 3 = เริ่มเบื่อ</div>} />
          </section>

          {view.results.length > 0 && (
            <section className="in-res">
              {view.results.map((r) => (
                <div className="kpi in-res-card" key={r.indicator}>
                  <div><div className="label">ผลลัพธ์ · {r.label}</div><div className="value num">{int(r.value)} <span className="unit">{r.unit}</span></div></div>
                  <div><div className="label">ต้นทุนต่อ{r.per === 1000 ? " 1,000 " : ""}{r.unit}</div><div className="value num">{b2(r.cost)}</div></div>
                  <div className="delta">จาก {r.campaigns} แคมเปญ · ใช้ไป {b2(r.spend)}<br />ผลลัพธ์ต่างชนิดไม่นำมารวมกัน</div>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {view && (
        <>
          <div className="section-title"><h2>คำแนะนำ</h2><span className="sub">คิดจากตัวเลขช่วงที่เลือก · แนะนำอย่างเดียว ไม่แก้อะไรบน Meta — กดลิงก์ไปแก้เองใน Ads Manager</span></div>
          <div className="in-sumbar">
            {SEV_ORDER.map((s) => <span key={s} className={`in-sev ${s}`}>{SEV[s].icon} {SEV[s].label} {view.recs.filter((r) => r.sev === s).length}</span>)}
            <span className="spacer" />
            <button type="button" className="linkish" onClick={() => setShowRules((v) => !v)}>{showRules ? "ซ่อนเกณฑ์" : `ดูเกณฑ์ (${view.rules.length} ข้อ)`}</button>
          </div>
          {showRules && <ul className="in-rules">{view.rules.map((r) => <li key={r.key}>{r.text}</li>)}</ul>}
          {view.recs.length ? (
            <div className="in-recs">
              {view.recs.map((r) => (
                <div key={r.id} className={`in-rec ${r.sev}`}>
                  <span className={`in-sev ${r.sev}`}>{SEV[r.sev].icon} {SEV[r.sev].label}{r.paused && <span className="in-paused">ปิดอยู่แล้ว</span>}</span>
                  <div className="in-rt">{r.title}</div>
                  <div className="in-re num">{r.evidence}</div>
                  <div className="in-rs">💡 {r.suggest}</div>
                  {r.link && <a href={r.link} target="_blank" rel="noreferrer">เปิดใน Ads Manager ↗</a>}
                </div>
              ))}
            </div>
          ) : <div className="card empty">ไม่มีอะไรผิดปกติตามเกณฑ์ในช่วงนี้</div>}

          {view.period && (
            <>
              {aiHere && ai.res && (
                <div className="in-ai">
                  <h3>✨ Claude สรุป · {rangeLabel} <span className="tag">{ai.res.model}</span></h3>
                  {ai.res.headline && <p className="in-ai-h">{ai.res.headline}</p>}
                  <ul>{ai.res.points?.map((p, i) => <li key={i}><b>{p.title}</b> {p.detail}</li>)}</ul>
                  {ai.res.try_first && <p><b>ลองก่อน:</b> {ai.res.try_first}</p>}
                  <div className="hint">AI สรุปจากตัวเลขในหน้านี้ — ตรวจกับตัวเลขจริงก่อนตัดสินใจ · ส่งไปเฉพาะตัวเลขสรุป ไม่มี token</div>
                </div>
              )}
              {aiHere && ai.err && <div className="banner in-err">✕ {ai.err}</div>}
              <div className="row" style={{ marginTop: 10, gap: 10, alignItems: "center" }}>
                <button className="btn primary" onClick={askAi} disabled={ai.busy}>{ai.busy ? "Claude กำลังอ่านตัวเลข…" : aiHere && ai.res ? "✨ สรุปใหม่" : "✨ ให้ Claude สรุปและแนะนำ"}</button>
                <span className="hint" style={{ margin: 0 }}>กดเองเท่านั้น · ใช้ ANTHROPIC_API_KEY ของ agent claude · เสียค่า API ทุกครั้งที่กด</span>
              </div>
            </>
          )}
        </>
      )}

      {view?.period && trend && (
        <>
          <div className="section-title"><h2>แนวโน้มรายวัน</h2><span className="sub">เลื่อนเมาส์บนกราฟเพื่อดูตัวเลขรายวัน</span></div>
          <div className="card">
            <div className="chart-head">
              <h3>{METRIC[metric].label} ต่อวัน</h3>
              <span className="spacer" />
              <div className="seg" role="group" aria-label="ตัวชี้วัดในกราฟ">
                {(Object.keys(METRIC) as MetricKey[]).map((m) => <button key={m} aria-pressed={metric === m} onClick={() => setMetric(m)}>{METRIC[m].label.replace(/ \(.*\)$/, "")}</button>)}
              </div>
            </div>
            <InsightsTrend dates={trend.dates} values={trend.values} format={METRIC[metric].fmt} label={METRIC[metric].label} />
            <div className="hint" style={{ margin: "6px 0 0" }}>
              {view.daily.length} วัน · มีการใช้เงิน {view.daily.filter((d) => d.spend > 0).length} วัน{metric === "ctr" || metric === "cpm" ? " · วันที่ไม่มีการแสดงผลเว้นช่องว่าง" : " · วันที่ไม่มีการแสดงผลนับเป็น 0"}{metric === "results" ? " · นับจำนวนรวมทุกชนิดผลลัพธ์ (ไม่รวมการเข้าถึง)" : ""}
            </div>
          </div>

          <div className="section-title"><h2>แคมเปญ → ชุดโฆษณา → โฆษณา</h2><span className="sub">กด ▸ เพื่อเจาะลง · ⛔▲⚠ = มีคำแนะนำ · ↗ เปิดใน Ads Manager</span></div>
          <div className="card" style={{ padding: "8px 10px" }}>
            <InsightsTable rows={view.campaigns} open={rows.open} onToggle={rows.toggle} />
            <div className="hint" style={{ margin: "8px 4px 2px" }}>
              แสดง {view.campaigns.length} แคมเปญที่มีค่าใช้จ่ายในช่วงนี้
              {view.idle.some((x) => x.agent) && <> · แคมเปญของ agent ที่ยังไม่ใช้เงินในช่วงนี้: {view.idle.filter((x) => x.agent).slice(0, 4).map((x) => x.name).join(", ")}</>}
              {" "}· อันดับ Meta (คุณภาพ · การมีส่วนร่วม · conversion): <span className="in-rank"><i className="above" /></span> สูงกว่า <span className="in-rank"><i className="average" /></span> เฉลี่ย <span className="in-rank"><i className="below" /></span> ต่ำกว่า <span className="in-rank"><i className="none" /></span> ยังไม่มี
            </div>
          </div>

          <div className="in-two">
            <div>
              <div className="section-title"><h2>อายุ × เพศ</h2><span className="sub">สีเข้ม = ใช้เงินมาก · บรรทัดล่าง = ต้นทุนต่อคลิกลิงก์</span></div>
              <AgeGrid data={view} />
            </div>
            <div>
              <div className="section-title"><h2>ตำแหน่งโฆษณา</h2><span className="sub">เรียงตามเงินที่ใช้ · ⚠ สีส้ม = ต้นทุนต่อคลิกเกิน 2 เท่าของค่าเฉลี่ย</span></div>
              <div className="card">
                {view.placements.map((p) => (
                  <div className="in-pl" key={p.key} title={`${p.label}: ใช้ไป ${b2(p.spend)} · คลิกลิงก์ ${int(p.link_clicks)}`}>
                    <span>{p.hot && <span className="in-sev warning">⚠ </span>}{p.label}</span>
                    <span className="in-bar"><i className={p.hot ? "hot" : ""} style={{ width: `${(p.spend / view.placements[0].spend) * 100}%` }} /></span>
                    <span className="num in-plv">{b0(p.spend)} · {Math.round(p.share * 100)}%<small>{p.cpc !== null ? `${b2(p.cpc)}/คลิก` : "ไม่มีคลิก"}</small></span>
                  </div>
                ))}
                <div className="hint" style={{ margin: "8px 0 0" }}>ตำแหน่งที่ใช้เงินไม่ถึง ฿1 ซ่อนไว้</div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Kpi({ label, value, d }: { label: string; value: string; d: React.ReactNode }) {
  return <div className="kpi"><div className="label">{label}</div><div className="value">{value}</div>{d}</div>;
}

function AgeGrid({ data }: { data: InsightsData }) {
  const max = Math.max(...data.age.map((a) => a.spend), 1);
  const cell = (age: string, g: string) => data.age.find((a) => a.age === age && a.gender === g);
  const old = data.age.filter((a) => a.age === "55-64" || a.age === "65+").reduce((s, a) => s + a.spend, 0);
  const accCpc = data.total.link_clicks ? data.total.spend / data.total.link_clicks : null;
  if (!data.age.length) return <div className="card empty">ไม่มีข้อมูลอายุ/เพศในช่วงนี้</div>;
  return (
    <div className="card">
      <div className="in-hm num" role="table" aria-label="ใช้เงินแยกอายุและเพศ">
        <div />
        {GENDERS.map(([, l]) => <div key={l} className="h">{l}</div>)}
        {AGES.map((age) => (
          <Row key={age} age={age} cells={GENDERS.map(([g]) => cell(age, g))} max={max} />
        ))}
      </div>
      <div className="hint" style={{ margin: "8px 0 0" }}>
        อายุ 55 ขึ้นไปใช้งบ {data.total.spend ? Math.round((old / data.total.spend) * 100) : 0}% · ต้นทุนต่อคลิกเฉลี่ยทั้งบัญชี {b2(accCpc)}
      </div>
    </div>
  );
}

function Row({ age, cells, max }: { age: string; cells: (InsightsData["age"][number] | undefined)[]; max: number }) {
  return (
    <>
      <div className="r">{age}</div>
      {cells.map((c, i) => {
        const s = c?.spend ?? 0, k = c?.link_clicks ?? 0;
        const step = Math.round((s / max) * (RAMP.length - 1));
        return (
          <div key={i} className="c" style={{ background: RAMP[step] }} title={`${age} ${GENDERS[i][1]}: ใช้ไป ${b2(s)} · คลิกลิงก์ ${int(k)}`}>
            {s ? b0(s) : "—"}<small>{k ? `${b2(s / k)}/คลิก` : ""}</small>
          </div>
        );
      })}
    </>
  );
}
