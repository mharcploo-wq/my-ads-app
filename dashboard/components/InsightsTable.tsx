"use client";
import { useState } from "react";
import type { Node, Rank, Sev } from "@/lib/insightsTypes";
import { AGENTS } from "@/lib/types";
import { SEV } from "@/lib/insightsTypes";

const b2 = (v: number | null) => (v === null ? "—" : `฿${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const int = (v: number) => Math.round(v).toLocaleString("en-US");

function Dots({ r }: { r: NonNullable<Node["ranking"]> }) {
  const one = (k: string, x: Rank) => <i key={k} className={x.level ?? "none"} />;
  return (
    <span className="in-rank" title={`คุณภาพ: ${r.quality.text}\nการมีส่วนร่วม: ${r.engagement.text}\nconversion: ${r.conversion.text}`}>
      {one("q", r.quality)}{one("e", r.engagement)}{one("c", r.conversion)}
    </span>
  );
}

/** ตาราง แคมเปญ → ชุดโฆษณา → โฆษณา (เจาะลงได้) — ตัวเลขทั้งหมดคิดที่ server */
export default function InsightsTable({ rows, open, onToggle }: { rows: Node[]; open: Set<string>; onToggle: (id: string) => void }) {
  const out: React.ReactNode[] = [];
  const walk = (n: Node, depth: number) => {
    const kids = n.children.length > 0;
    const on = open.has(n.id);
    const sev: Sev | null = n.flag;
    out.push(
      <tr key={n.id} className={`in-l${depth}`}>
        <td className="l">
          <span className="in-name">
            {kids ? (
              <button type="button" className="in-tw" aria-expanded={on} aria-label={on ? "ย่อ" : "เจาะลง"} onClick={() => onToggle(n.id)}>{on ? "▾" : "▸"}</button>
            ) : <span className="in-tw" />}
            <span className="in-nm" title={n.name}>{n.name}</span>
            {n.agent && <span className="tag"><span className="swatch" style={{ background: AGENTS[n.agent].color }} />{AGENTS[n.agent].label}</span>}
            {n.level === "campaign" && <span className={`in-st ${n.active ? "on" : ""}`}>{n.active ? "● เปิด" : "○ ปิด"}</span>}
            {sev && <span className={`in-sev ${sev}`} title={SEV[sev].label}>{SEV[sev].icon}</span>}
            <a className="in-am" href={n.link} target="_blank" rel="noreferrer" title="เปิดใน Ads Manager">↗</a>
          </span>
        </td>
        <td>{n.result ? <>{int(n.result.value)} <small className="in-u">{n.result.short}</small></> : "—"}</td>
        <td>{n.result?.cost != null ? b2(n.result.cost) : "—"}</td>
        <td>{b2(n.m.spend)}</td>
        <td>{int(n.m.impressions)}</td>
        <td>{int(n.m.reach)}</td>
        <td>{n.m.frequency.toFixed(2)}</td>
        <td>{n.m.link_ctr.toFixed(2)}%</td>
        <td>{b2(n.m.link_cpc)}</td>
        <td>{b2(n.m.cpm)}</td>
        <td>{n.ranking ? <Dots r={n.ranking} /> : ""}</td>
      </tr>,
    );
    if (on) n.children.forEach((c) => walk(c, depth + 1));
  };
  rows.forEach((r) => walk(r, 1));

  return (
    <div className="table-scroll">
      <table className="in-table num">
        <thead>
          <tr>
            <th className="l">ชื่อ</th><th>ผลลัพธ์</th><th>ต้นทุน/ผลลัพธ์</th><th>ใช้ไป</th><th>การแสดงผล</th><th>การเข้าถึง</th>
            <th>ความถี่</th><th>CTR ลิงก์</th><th>CPC ลิงก์</th><th>CPM</th><th title="คุณภาพ · การมีส่วนร่วม · conversion">อันดับ Meta</th>
          </tr>
        </thead>
        <tbody>{out}</tbody>
      </table>
    </div>
  );
}

/** เก็บสถานะเปิด/ปิดแถว */
export function useOpenRows() {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { open, toggle, reset: () => setOpen(new Set()) };
}
