"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import AgentCompare from "@/components/AgentCompare";
import CampaignTable from "@/components/CampaignTable";
import ConnectPanel from "@/components/ConnectPanel";
import TrendChart from "@/components/TrendChart";
import { campaignStats, dateWindow, fmt, seriesByAgent, totals } from "@/lib/calc";
import { AGENTS, MetricsResponse, Prefix, PREFIXES } from "@/lib/types";

type Tab = "overview" | "connect";
type Metric = "spend" | "results" | "link_clicks";
const METRIC_LABEL: Record<Metric, string> = { spend: "ค่าใช้จ่าย (บาท)", results: "ผลลัพธ์", link_clicks: "คลิกลิงก์" };

function Delta({ now, prev, invert = false, neutral = false }: { now: number | null; prev: number | null; invert?: boolean; neutral?: boolean }) {
  if (now === null || prev === null || prev === 0) return <div className="delta">ไม่มีข้อมูลช่วงก่อนหน้า</div>;
  const pct = ((now - prev) / prev) * 100;
  const up = pct >= 0;
  const good = invert ? !up : up;
  return (
    <div className="delta">
      <span style={{ color: neutral ? "var(--text-secondary)" : good ? "#6fd46f" : "#ff8a8a" }}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%</span> เทียบช่วงก่อน
    </div>
  );
}

export default function Page() {
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState(14);
  const [agent, setAgent] = useState<Prefix | "all">("all");
  const [metric, setMetric] = useState<Metric>("spend");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/metrics", { cache: "no-store" });
      setData(await r.json());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30000); // รีเฟรชทุก 30 วิ เผื่อ agent ส่งข้อมูลเข้ามา
    return () => clearInterval(t);
  }, [load]);

  const view = useMemo(() => {
    if (!data) return null;
    const { dates, prev } = dateWindow(data.rows, days);
    const inWin = new Set(dates);
    const inPrev = new Set(prev);
    const pick = (p: Prefix) => agent === "all" || agent === p;
    const rowsNow = data.rows.filter((r) => inWin.has(r.date) && pick(r.prefix));
    const rowsPrev = data.rows.filter((r) => inPrev.has(r.date) && pick(r.prefix));
    const all = seriesByAgent(data.rows, dates, metric);
    const series = Object.fromEntries(PREFIXES.filter(pick).map((p) => [p, all[p]]));
    const agentStats = PREFIXES.map((p) => {
      const camps = data.campaigns.filter((c) => c.prefix === p);
      return {
        prefix: p,
        t: totals(data.rows.filter((r) => r.prefix === p && inWin.has(r.date))),
        campaigns: camps.length,
        paused: camps.filter((c) => c.status.includes("PAUSED")).length,
      };
    });
    const camps = campaignStats(data.campaigns.filter((c) => pick(c.prefix)), data.rows.filter((r) => inWin.has(r.date)));
    return { dates, now: totals(rowsNow), prev: rowsPrev.length ? totals(rowsPrev) : null, series, agentStats, camps };
  }, [data, days, agent, metric]);

  const connected = data && !data.demo;

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <div className="logo">f</div>
          <div className="brand">
            <h1>Ads Control</h1>
            <p>ศูนย์ควบคุมแคมเปญ Meta Ads · Claude vs Manus vs ChatGPT</p>
          </div>
          <nav className="tabs" role="tablist" style={{ marginLeft: 24 }}>
            <button role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>ภาพรวม</button>
            <button role="tab" aria-selected={tab === "connect"} onClick={() => setTab("connect")}>เชื่อมต่อ API</button>
          </nav>
          <span className="spacer" />
          {data && (
            <span className={`pill ${connected ? "ok" : "warn"}`}>
              <span className="dot" style={{ background: connected ? "var(--good)" : "var(--warning)" }} />
              {connected ? "ข้อมูลจริง" : "ข้อมูลตัวอย่าง"}
            </span>
          )}
        </div>
      </header>

      <main className="wrap">
        {err && <div className="banner">โหลดข้อมูลไม่สำเร็จ: {err}</div>}
        {!data && !err && <div className="empty">กำลังโหลด…</div>}

        {data && data.demo && (
          <div className="banner">
            <span>⚠</span>
            <span>ยังไม่มีข้อมูลจริง — ตัวเลขทั้งหมดในหน้านี้เป็น<b>ข้อมูลตัวอย่าง</b> เชื่อมต่อแล้วข้อมูลจริงจะแทนที่ทันที</span>
            <button className="btn" onClick={() => setTab("connect")}>ไปหน้าเชื่อมต่อ API</button>
          </div>
        )}

        {data && view && tab === "overview" && (
          <>
            <div className="filters">
              <div className="seg" role="group" aria-label="ช่วงเวลา">
                {[7, 14, 30].map((d) => (
                  <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d} วัน</button>
                ))}
              </div>
              <div className="seg" role="group" aria-label="Agent">
                <button aria-pressed={agent === "all"} onClick={() => setAgent("all")}>ทุก Agent</button>
                {PREFIXES.map((p) => (
                  <button key={p} aria-pressed={agent === p} onClick={() => setAgent(p)}>
                    <span className="swatch" style={{ background: AGENTS[p].color }} />{AGENTS[p].label}
                  </button>
                ))}
              </div>
              <span className="spacer" />
              {view.dates.length > 0 && (
                <span className="hint" style={{ margin: 0, color: "var(--text-muted)" }}>
                  {fmt.dateShort(view.dates[0])} – {fmt.dateShort(view.dates[view.dates.length - 1])}
                </span>
              )}
            </div>

            <section className="kpis num" aria-label="ตัวชี้วัดหลัก">
              <div className="kpi"><div className="label">ค่าใช้จ่าย</div><div className="value">{fmt.baht(view.now.spend)}</div><Delta now={view.now.spend} prev={view.prev?.spend ?? null} neutral /></div>
              <div className="kpi"><div className="label">การแสดงผล</div><div className="value">{fmt.compact(view.now.impressions)}</div><Delta now={view.now.impressions} prev={view.prev?.impressions ?? null} /></div>
              <div className="kpi"><div className="label">คลิกลิงก์</div><div className="value">{fmt.int(view.now.link_clicks)}</div><Delta now={view.now.link_clicks} prev={view.prev?.link_clicks ?? null} /></div>
              <div className="kpi"><div className="label">CTR</div><div className="value">{fmt.pct(view.now.ctr)}</div><Delta now={view.now.ctr} prev={view.prev?.ctr ?? null} /></div>
              <div className="kpi"><div className="label">ผลลัพธ์</div><div className="value">{fmt.int(view.now.results)}</div><Delta now={view.now.results} prev={view.prev?.results ?? null} /></div>
              <div className="kpi"><div className="label">ต้นทุน/ผลลัพธ์</div><div className="value">{fmt.baht(view.now.cpr)}</div><Delta now={view.now.cpr} prev={view.prev?.cpr ?? null} invert /></div>
            </section>

            <div className="section-title"><h2>แนวโน้มรายวัน</h2><span className="sub">เลื่อนเมาส์บนกราฟเพื่อดูตัวเลขรายวัน</span></div>
            <div className="card">
              <div className="chart-head">
                <h3>{METRIC_LABEL[metric]} แยกตาม Agent</h3>
                <span className="spacer" />
                <div className="seg" role="group" aria-label="ตัวชี้วัดในกราฟ">
                  {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
                    <button key={m} aria-pressed={metric === m} onClick={() => setMetric(m)}>{METRIC_LABEL[m].replace(" (บาท)", "")}</button>
                  ))}
                </div>
              </div>
              <div className="legend" style={{ marginBottom: 6 }}>
                {(Object.keys(view.series) as Prefix[]).map((p) => (
                  <span key={p}><i className="line" style={{ background: AGENTS[p].color }} />{AGENTS[p].label} <span className="tag">{p}</span></span>
                ))}
              </div>
              <TrendChart dates={view.dates} series={view.series} format={metric === "spend" ? (n) => fmt.baht(n) : fmt.int} />
            </div>

            <div className="section-title"><h2>เปรียบเทียบ 3 Agents</h2><span className="sub">Claude vs Manus vs ChatGPT · ช่วง {days} วันล่าสุด</span></div>
            <AgentCompare stats={view.agentStats} />

            <div className="section-title"><h2>แคมเปญทั้งหมด</h2><span className="sub">ผลรวมในช่วง {days} วันล่าสุด</span></div>
            <CampaignTable rows={view.camps} />
          </>
        )}

        {data && tab === "connect" && (
          <>
            <div className="section-title"><h2>เชื่อมต่อ API จริง</h2><span className="sub">ส่งข้อมูลจาก MCP Server หรือดึงตรงจาก Meta Graph API</span></div>
            <ConnectPanel data={data} onChanged={load} />
          </>
        )}
      </main>
    </>
  );
}
