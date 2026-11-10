"use client";
import { useEffect, useState } from "react";
import { fmt } from "@/lib/calc";
import { AGENTS, MetricsResponse, Prefix, PREFIXES } from "@/lib/types";

type Check = { label: string; ok: boolean; detail: string };

export default function ConnectPanel({ data, onChanged }: { data: MetricsResponse; onChanged: () => void }) {
  const [origin, setOrigin] = useState("http://localhost:3000");
  useEffect(() => setOrigin(window.location.origin), []);
  const ingestUrl = `${origin}/api/ingest`;

  // --- ทดสอบ secret ---
  const [secret, setSecret] = useState("");
  const [pingMsg, setPingMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ping = async () => {
    setPingMsg(null);
    const r = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ ping: true }),
    });
    const j = await r.json().catch(() => ({}));
    setPingMsg({ ok: r.ok, text: j.message ?? j.error ?? `HTTP ${r.status}` });
  };
  const clearAll = async () => {
    if (!confirm("ล้างข้อมูลทั้งหมดใน Dashboard? (ไม่กระทบแคมเปญใน Meta)")) return;
    const r = await fetch("/api/metrics", { method: "DELETE", headers: { authorization: `Bearer ${secret}` } });
    setPingMsg({ ok: r.ok, text: r.ok ? "ล้างข้อมูลแล้ว" : "secret ไม่ถูกต้อง — ต้องใส่ secret ก่อนล้างข้อมูล" });
    onChanged();
  };

  // --- Meta Graph API ตรง ---
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [preset, setPreset] = useState("last_7d");
  const [busy, setBusy] = useState<"" | "test" | "sync">("");
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const call = async (action: "test" | "sync") => {
    setBusy(action);
    setSyncMsg(null);
    try {
      const r = await fetch("/api/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, date_preset: preset }) });
      const j = await r.json();
      if (action === "test") setChecks(j.checks);
      else {
        setSyncMsg({ ok: j.ok, text: j.ok ? `ดึงสำเร็จ: ${j.campaigns} แคมเปญ, ${j.rows} แถวรายวัน` : j.error });
        if (j.ok) onChanged();
      }
    } finally {
      setBusy("");
    }
  };

  // --- ตัวสร้าง .env ---
  const [agent, setAgent] = useState<Prefix>("CLD-");
  const [budget, setBudget] = useState(500);
  const [perDay, setPerDay] = useState(3);
  const [copied, setCopied] = useState(false);
  const envText = [
    `AGENT=${AGENTS[agent].key}`,
    `META_ACCESS_TOKEN=ใส่โทเคน System User ของ ${AGENTS[agent].label} (ห้ามแชร์)`,
    `META_AD_ACCOUNT_ID=${data.config.adAccountId ?? "act_ใส่เลขบัญชี"}`,
    "META_PAGE_ID=ใส่เลขเพจ",
    `AGENT_PREFIX=${agent}`,
    `MAX_DAILY_BUDGET_THB=${budget}`,
    `MAX_CAMPAIGNS_PER_DAY=${perDay}`,
    "GRAPH_API_VERSION=v21.0",
    `DASHBOARD_API_URL=${ingestUrl}`,
    "DASHBOARD_API_SECRET=ค่าเดียวกับ dashboard/.env.local",
  ].join("\n");
  const copy = async () => {
    await navigator.clipboard.writeText(envText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="connect">
      <div className="card">
        <h3>1. รับข้อมูลจาก MCP Server</h3>
        <p className="hint">Agent เรียก tool <code>send_to_dashboard</code> แล้วผลจะถูกส่งมาที่ endpoint นี้</p>
        <div className="field">
          <label>Endpoint (ใส่ใน DASHBOARD_API_URL)</label>
          <pre className="codebox mono">{ingestUrl}</pre>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className={`pill ${data.config.secretSet ? "ok" : "bad"}`}>
            {data.config.secretSet ? "✓ ตั้ง DASHBOARD_API_SECRET แล้ว" : "✕ ยังไม่ได้ตั้ง DASHBOARD_API_SECRET ใน .env.local"}
          </span>
        </div>
        <div className="field">
          <label htmlFor="secret">ทดสอบ secret (ไม่ถูกบันทึก)</label>
          <div className="row">
            <input id="secret" className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="วาง DASHBOARD_API_SECRET" style={{ flex: 1 }} />
            <button className="btn" onClick={ping} disabled={!secret}>ทดสอบเชื่อมต่อ</button>
          </div>
          {pingMsg && <div className={`msg ${pingMsg.ok ? "ok" : "no"}`}>{pingMsg.ok ? "✓ " : "✕ "}{pingMsg.text}</div>}
        </div>
        <label style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>รับข้อมูลล่าสุด</label>
        <div className="sync-list">
          {PREFIXES.map((p) => {
            const s = data.syncs[p];
            return (
              <div className="it" key={p}>
                <span className="swatch" style={{ background: AGENTS[p].color }} />
                <b>{AGENTS[p].label}</b> <span className="tag">{p}</span>
                <span className="when">{s ? `${fmt.ago(s.at)} · ${s.source === "mcp" ? "MCP" : "Meta API"} · ${s.rows} แถว` : "ยังไม่เคยส่ง"}</span>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn danger" onClick={clearAll} disabled={!secret}>ล้างข้อมูลใน Dashboard</button>
        </div>
      </div>

      <div className="card">
        <h3>2. ดึงข้อมูลจาก Meta Graph API ตรง</h3>
        <p className="hint">ใช้ <code>META_READ_TOKEN</code> ใน <code>dashboard/.env.local</code> (สิทธิ์ ads_read) — โทเคนอยู่ฝั่ง server ไม่ถูกส่งมาที่เบราว์เซอร์ · แยก Agent จาก Prefix ชื่อแคมเปญ</p>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className={`pill ${data.config.metaReady ? "ok" : "warn"}`}>
            {data.config.metaReady ? `✓ พร้อม · ${data.config.adAccountId}` : "! ยังไม่ได้ตั้ง META_READ_TOKEN / META_AD_ACCOUNT_ID"}
          </span>
        </div>
        <div className="row">
          <button className="btn" onClick={() => call("test")} disabled={busy !== ""}>{busy === "test" ? "กำลังตรวจ…" : "ทดสอบการเชื่อมต่อ"}</button>
          <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="ช่วงข้อมูล">
            <option value="yesterday">เมื่อวาน</option>
            <option value="last_7d">7 วันล่าสุด</option>
            <option value="last_14d">14 วันล่าสุด</option>
            <option value="last_30d">30 วันล่าสุด</option>
            <option value="this_month">เดือนนี้</option>
          </select>
          <button className="btn primary" onClick={() => call("sync")} disabled={busy !== "" || !data.config.metaReady}>
            {busy === "sync" ? "กำลังดึง…" : "ดึงข้อมูลตอนนี้"}
          </button>
        </div>
        {checks && (
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.label}>
                <span className={`ic ${c.ok ? "ok" : "no"}`}>{c.ok ? "✓" : "✕"}</span>
                <span>{c.label}<div className="d">{c.detail}</div></span>
              </li>
            ))}
          </ul>
        )}
        {syncMsg && <div className={`msg ${syncMsg.ok ? "ok" : "no"}`}>{syncMsg.ok ? "✓ " : "✕ "}{syncMsg.text}</div>}
      </div>

      <div className="card">
        <h3>3. สร้างไฟล์ .env ของแต่ละ Agent</h3>
        <p className="hint">เลือก Agent แล้วคัดลอกไปวางใน <code>mcp-server/.env.{AGENTS[agent].key}</code> จากนั้นใส่โทเคนจริงเองในเครื่อง</p>
        <div className="seg" role="group" aria-label="เลือก Agent" style={{ marginBottom: 14 }}>
          {PREFIXES.map((p) => (
            <button key={p} aria-pressed={agent === p} onClick={() => setAgent(p)}>
              <span className="swatch" style={{ background: AGENTS[p].color }} />{AGENTS[p].label} <span className="tag">{p}</span>
            </button>
          ))}
        </div>
        <div className="field">
          <label>งบสูงสุดต่อวัน (MAX_DAILY_BUDGET_THB): <b className="num">{fmt.int(budget)} บาท</b></label>
          <input type="range" min={100} max={5000} step={100} value={budget} onChange={(e) => setBudget(+e.target.value)} />
        </div>
        <div className="field">
          <label>แคมเปญสูงสุดต่อวัน (MAX_CAMPAIGNS_PER_DAY)</label>
          <div className="row">
            <button className="btn" onClick={() => setPerDay((n) => Math.max(1, n - 1))}>−</button>
            <b className="num" style={{ minWidth: 24, textAlign: "center" }}>{perDay}</b>
            <button className="btn" onClick={() => setPerDay((n) => Math.min(20, n + 1))}>+</button>
          </div>
        </div>
        <pre className="codebox mono">{envText}</pre>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={copy}>{copied ? "คัดลอกแล้ว ✓" : "คัดลอก"}</button>
        </div>
      </div>

      <div className="card">
        <h3>กฎความปลอดภัยที่ MCP Server บังคับ</h3>
        <p className="hint">ตรวจในโค้ดทุกครั้ง ไม่ได้พึ่งให้ AI ทำตามเอง</p>
        <ul className="rules">
          <li>สร้างแคมเปญ / Ad Set / โฆษณา เป็น <b>PAUSED</b> เท่านั้น — payload ที่เป็น ACTIVE ถูกบล็อกก่อนยิง API</li>
          <li>ทุก <code>create_*</code> เรียก <code>check_permission</code> ก่อน: โทเคน · สิทธิ์บัญชี · งบ ≤ เพดาน · จำนวนแคมเปญ/วัน</li>
          <li>ชื่อทุกชิ้นเติม Prefix อัตโนมัติ (CLD- / MANUS- / GPT-) และแก้ได้เฉพาะของ Prefix ตัวเอง</li>
          <li>Ad Set ใช้ Advantage+ Audience (ไทย 20+) ไม่ใส่ interest แคบ ๆ</li>
          <li>โทเคนอ่านจาก .env เท่านั้น ไม่ถูกเขียนลง audit log</li>
        </ul>
        <div className="banner" style={{ marginTop: 14 }}>
          <span>⚠</span><span>ห้ามวางโทเคนจริงในช่องใด ๆ บนหน้าเว็บ — ใส่ในไฟล์ .env บนเครื่องเท่านั้น</span>
        </div>
      </div>
    </div>
  );
}
