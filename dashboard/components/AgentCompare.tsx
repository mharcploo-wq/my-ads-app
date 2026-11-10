"use client";
import { useState } from "react";
import { fmt, Totals } from "@/lib/calc";
import { AGENTS, Prefix } from "@/lib/types";

interface AgentStat {
  prefix: Prefix;
  t: Totals;
  campaigns: number;
  paused: number;
}

type MetricKey = "spend" | "results" | "cpr" | "ctr";
const METRICS: { key: MetricKey; label: string; better: "high" | "low" | null; f: (t: Totals) => number | null; show: (n: number | null) => string }[] = [
  { key: "spend", label: "ค่าใช้จ่าย", better: null, f: (t) => t.spend, show: (n) => fmt.baht(n) },
  { key: "results", label: "ผลลัพธ์ (ลีด/ยอดขาย)", better: "high", f: (t) => t.results, show: (n) => fmt.int(n ?? 0) },
  { key: "cpr", label: "ต้นทุนต่อผลลัพธ์ (ต่ำ = ดี)", better: "low", f: (t) => t.cpr, show: (n) => fmt.baht(n) },
  { key: "ctr", label: "CTR คลิกลิงก์", better: "high", f: (t) => t.ctr, show: (n) => (n === null ? "—" : fmt.pct(n)) },
];

function bestOf(stats: AgentStat[], m: (typeof METRICS)[number]): Prefix | null {
  if (!m.better) return null;
  const vals = stats.map((s) => ({ p: s.prefix, v: m.f(s.t) })).filter((x) => x.v !== null && x.v > 0) as { p: Prefix; v: number }[];
  if (vals.length < 2) return null;
  vals.sort((a, b) => (m.better === "high" ? b.v - a.v : a.v - b.v));
  return vals[0].p;
}

export default function AgentCompare({ stats }: { stats: AgentStat[] }) {
  const [tip, setTip] = useState<string | null>(null);
  const cprBest = bestOf(stats, METRICS[2]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="agents">
        {stats.map((s) => (
          <div key={s.prefix} className="agent-card" style={{ ["--c" as string]: AGENTS[s.prefix].color }}>
            <div className="head">
              <span className="swatch" style={{ background: AGENTS[s.prefix].color }} />
              <span className="name">{AGENTS[s.prefix].label}</span>
              <span className="tag">{s.prefix}</span>
              {cprBest === s.prefix && <span className="best">คุ้มที่สุด</span>}
            </div>
            <div className="stat-rows num">
              <span className="k">แคมเปญ</span><span className="v">{s.campaigns} ({s.paused} หยุดอยู่)</span>
              <span className="k">ค่าใช้จ่าย</span><span className="v">{fmt.baht(s.t.spend)}</span>
              <span className="k">การแสดงผล</span><span className="v">{fmt.int(s.t.impressions)}</span>
              <span className="k">คลิกลิงก์</span><span className="v">{fmt.int(s.t.link_clicks)}</span>
              <span className="k">CTR</span><span className="v">{fmt.pct(s.t.ctr)}</span>
              <span className="k">ผลลัพธ์</span><span className="v">{fmt.int(s.t.results)}</span>
              <span className="k">ต้นทุน/ผลลัพธ์</span><span className="v">{fmt.baht(s.t.cpr)}</span>
              <span className="k">CPM</span><span className="v">{fmt.baht(s.t.cpm)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="chart-head">
          <h3>เทียบรายตัวชี้วัด</h3>
          <span className="spacer" />
          <span className="hint" style={{ margin: 0 }}>แต่ละกราฟมีสเกลของตัวเอง</span>
        </div>
        <div className="multiples">
          {METRICS.map((m) => {
            const vals = stats.map((s) => m.f(s.t) ?? 0);
            const max = Math.max(...vals, 0) || 1;
            const best = bestOf(stats, m);
            return (
              <div className="mini" key={m.key}>
                <h4>{m.label}</h4>
                {stats.map((s, i) => {
                  const id = `${m.key}-${s.prefix}`;
                  return (
                    <div key={s.prefix} className="bar-row" onMouseEnter={() => setTip(id)} onMouseLeave={() => setTip(null)}
                      title={`${AGENTS[s.prefix].label} · ${m.label}: ${m.show(m.f(s.t))}`}>
                      <span className="lbl">{AGENTS[s.prefix].label}</span>
                      <span className="track">
                        <span className="fill" style={{ display: "block", width: `${(vals[i] / max) * 100}%`, background: AGENTS[s.prefix].color, outline: tip === id ? "1px solid var(--text-primary)" : undefined }} />
                      </span>
                      <span className="val num">
                        {m.show(m.f(s.t))}
                        {best === s.prefix && <span className="best" aria-label="ดีที่สุด">★</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
