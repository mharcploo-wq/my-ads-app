"use client";
import { useMemo, useState } from "react";
import AdsetInterests from "@/components/AdsetInterests";
import { CampaignStat, fmt } from "@/lib/calc";
import { AGENTS } from "@/lib/types";

type AgentId = "claude" | "manus" | "chatgpt";

type SortKey = "name" | "status" | "spend" | "impressions" | "link_clicks" | "ctr" | "results" | "cpr";
const COLS: { key: SortKey; label: string; left?: boolean }[] = [
  { key: "name", label: "แคมเปญ", left: true },
  { key: "status", label: "สถานะ", left: true },
  { key: "spend", label: "ค่าใช้จ่าย" },
  { key: "impressions", label: "การแสดงผล" },
  { key: "link_clicks", label: "คลิกลิงก์" },
  { key: "ctr", label: "CTR" },
  { key: "results", label: "ผลลัพธ์" },
  { key: "cpr", label: "ต้นทุน/ผลลัพธ์" },
];

const STATUS: Record<string, { th: string; c: string }> = {
  ACTIVE: { th: "กำลังวิ่ง", c: "var(--good)" },
  PAUSED: { th: "หยุดชั่วคราว", c: "var(--warning)" },
  CAMPAIGN_PAUSED: { th: "หยุดชั่วคราว", c: "var(--warning)" },
  ARCHIVED: { th: "เก็บถาวร", c: "var(--text-muted)" },
  DELETED: { th: "ลบแล้ว", c: "var(--critical)" },
  WITH_ISSUES: { th: "มีปัญหา", c: "var(--critical)" },
};

const OBJ: Record<string, string> = {
  OUTCOME_TRAFFIC: "ทราฟฟิก", OUTCOME_LEADS: "ลีด", OUTCOME_SALES: "ยอดขาย",
  OUTCOME_AWARENESS: "การรับรู้", OUTCOME_ENGAGEMENT: "การมีส่วนร่วม",
};

/** editable = ข้อมูลจริง (ข้อมูลตัวอย่างไม่มี Ad Set จริงให้แก้) */
export default function CampaignTable({ rows, editable = false }: { rows: CampaignStat[]; editable?: boolean }) {
  const [edit, setEdit] = useState<{ agent: AgentId; campaignId: string } | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "spend", desc: true });

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = rows.filter((r) =>
      (!s || r.name.toLowerCase().includes(s)) &&
      (status === "all" || (status === "PAUSED" ? r.status.includes("PAUSED") : r.status === status)));
    const val = (r: CampaignStat) => (sort.k === "cpr" ? r.cpr ?? Infinity : r[sort.k]);
    out.sort((a, b) => {
      const A = val(a), B = val(b);
      const c = typeof A === "string" ? A.localeCompare(String(B), "th") : (A as number) - (B as number);
      return sort.desc ? -c : c;
    });
    return out;
  }, [rows, q, status, sort]);

  return (
    <div className="card">
      <div className="table-tools">
        <input className="input" placeholder="ค้นหาชื่อแคมเปญ…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="กรองสถานะ">
          <option value="all">ทุกสถานะ</option>
          <option value="ACTIVE">กำลังวิ่ง</option>
          <option value="PAUSED">หยุดชั่วคราว</option>
        </select>
        <span className="spacer" />
        <span className="hint" style={{ margin: 0 }}>{list.length} แคมเปญ · คลิกหัวคอลัมน์เพื่อเรียง</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className={c.left ? "l" : undefined}
                  onClick={() => setSort((s) => ({ k: c.key, desc: s.k === c.key ? !s.desc : c.key !== "name" }))}
                  aria-sort={sort.k === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                  {c.label} {sort.k === c.key ? (sort.desc ? "↓" : "↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="num">
            {list.map((r) => {
              const st = STATUS[r.status] ?? { th: r.status, c: "var(--text-muted)" };
              return (
                <tr key={r.id}>
                  <td>
                    <div className="camp-name" title={r.name}>
                      <span className="swatch" style={{ background: AGENTS[r.prefix].color }} />
                      <span className="tag">{r.prefix}</span>
                      <span>{r.name.slice(r.prefix.length)}</span>
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginLeft: 18 }}>
                      {AGENTS[r.prefix].label}{r.objective ? ` · ${OBJ[r.objective] ?? r.objective}` : ""}
                    </div>
                    {editable && r.status.includes("PAUSED") && (
                      <button className="btn camp-act" title="แก้ความสนใจของ Ad Set ในแคมเปญนี้ (เฉพาะที่หยุดอยู่)"
                        onClick={() => setEdit({ agent: AGENTS[r.prefix].key as AgentId, campaignId: r.id })}>＋ ความสนใจ</button>
                    )}
                  </td>
                  <td className="l"><span className="status" style={{ ["--c" as string]: st.c }}>{st.th}</span></td>
                  <td>{fmt.baht(r.spend)}</td>
                  <td>{fmt.int(r.impressions)}</td>
                  <td>{fmt.int(r.link_clicks)}</td>
                  <td>{fmt.pct(r.ctr)}</td>
                  <td>{fmt.int(r.results)}</td>
                  <td>{fmt.baht(r.cpr)}</td>
                </tr>
              );
            })}
            {!list.length && (
              <tr><td colSpan={COLS.length} className="empty">ไม่พบแคมเปญที่ตรงเงื่อนไข</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {edit && <AdsetInterests agent={edit.agent} campaignId={edit.campaignId} onClose={() => setEdit(null)} />}
    </div>
  );
}
