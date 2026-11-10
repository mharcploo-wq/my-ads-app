"use client";
import { useCallback, useEffect, useState } from "react";
import { AGENTS, Prefix, PREFIXES } from "@/lib/types";

type Values = Record<string, string>;
type SecretInfo = { set: boolean; last4: string | null };
type EnvView = { agent: string; prefix: string; file: string; exists: boolean; values: Values; token: SecretInfo; secret: SecretInfo };
type Check = { key: string; label: string; ok: boolean; detail: string };
type Status = { ready?: boolean; configured?: boolean; reason?: string; checks?: Check[]; error?: string };

const MAIN: { key: string; label: string; hint?: string; num?: boolean }[] = [
  { key: "META_AD_ACCOUNT_ID", label: "บัญชีโฆษณา", hint: "act_ ตามด้วยตัวเลข" },
  { key: "META_PAGE_ID", label: "เพจ (เลขเพจ)" },
  { key: "MAX_DAILY_BUDGET_THB", label: "งบสูงสุดต่อวัน (บาท) · ไม่เกิน 1,000", num: true },
  { key: "MAX_CAMPAIGNS_PER_DAY", label: "แคมเปญสูงสุดต่อวัน · ไม่เกิน 5", num: true },
  { key: "META_PIXEL_ID", label: "Pixel (เว้นว่างได้)" },
  { key: "META_VERIFIED_IDENTITY_ID", label: "เลขผู้ลงโฆษณาที่ยืนยันตัวตน" },
];
const ADVANCED: { key: string; label: string }[] = [
  { key: "GRAPH_API_VERSION", label: "เวอร์ชัน Graph API" },
  { key: "DASHBOARD_API_URL", label: "ที่อยู่ส่งผลเข้า Dashboard" },
];

/** การ์ด "3. ตั้งค่า Agent" — กรอกแล้วบันทึกลง mcp-server/.env.{agent} แล้วตรวจสิทธิ์ทันที */
export default function AgentEnvForm() {
  const [agent, setAgent] = useState<Prefix>("CLD-");
  const key = AGENTS[agent].key;
  const [env, setEnv] = useState<EnvView | null>(null);
  const [values, setValues] = useState<Values>({});
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "load" | "save">("load");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const load = useCallback(async () => {
    setBusy("load");
    setMsg(null); setStatus(null); setErrors({}); setToken(""); setSecret("");
    try {
      const r = await fetch(`/api/agent-env?agent=${key}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setEnv(j.env);
      setValues(j.env.values);
    } catch (e) {
      setEnv(null);
      setMsg({ ok: false, text: `อ่านไฟล์ตั้งค่าไม่ได้: ${(e as Error).message}` });
    } finally {
      setBusy("");
    }
  }, [key]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy("save");
    setMsg(null); setStatus(null); setErrors({});
    try {
      const r = await fetch("/api/agent-env", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: key, values, token, secret }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErrors(j.errors ?? {});
        setMsg({ ok: false, text: j.error ?? `บันทึกไม่สำเร็จ (HTTP ${r.status})` });
        return;
      }
      setEnv(j.env);
      setValues(j.env.values);
      setToken(""); setSecret("");
      setStatus(j.status);
      setMsg({ ok: true, text: `บันทึกลง ${j.env.file} แล้ว` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const field = (f: { key: string; label: string; hint?: string; num?: boolean }) => (
    <div className="field" key={f.key}>
      <label htmlFor={`env-${f.key}`}>{f.label}</label>
      <input id={`env-${f.key}`} className={`input${errors[f.key] ? " invalid" : ""}`} value={values[f.key] ?? ""}
        inputMode={f.num ? "numeric" : undefined} placeholder={f.hint}
        onChange={(e) => set(f.key, e.target.value)} />
      {errors[f.key] && <div className="err">{errors[f.key]}</div>}
    </div>
  );

  return (
    <div className="card">
      <h3>3. ตั้งค่า Agent</h3>
      <p className="hint">แก้แล้วกดบันทึก ระบบเขียนลง <code>mcp-server/.env.{key}</code> ให้เอง แล้วตรวจสิทธิ์ทันที</p>
      <div className="seg" role="group" aria-label="เลือก Agent" style={{ marginBottom: 14 }}>
        {PREFIXES.map((p) => (
          <button key={p} aria-pressed={agent === p} onClick={() => setAgent(p)} disabled={busy === "save"}>
            <span className="swatch" style={{ background: AGENTS[p].color }} />{AGENTS[p].label} <span className="tag">{p}</span>
          </button>
        ))}
      </div>

      {busy === "load" && <p className="hint">กำลังอ่านไฟล์ตั้งค่า…</p>}
      {env && busy !== "load" && (
        <>
          {!env.exists && <div className="msg no" style={{ marginTop: 0, marginBottom: 10 }}>ยังไม่มีไฟล์ — กดบันทึกแล้วระบบจะสร้างให้</div>}
          <div className="field">
            <label htmlFor="env-token">
              รหัสเข้าใช้ (Token){" "}
              <span className={`pill ${env.token.set ? "ok" : "bad"}`}>{env.token.set ? `✓ ใส่แล้ว · ลงท้าย …${env.token.last4}` : "✕ ยังไม่ได้ใส่"}</span>
            </label>
            <input id="env-token" className={`input${errors.token ? " invalid" : ""}`} type="password" autoComplete="off" value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={env.token.set ? "เว้นว่าง = ใช้รหัสเดิม · วางใหม่เพื่อเปลี่ยน" : "วางรหัสที่ขึ้นต้นด้วย EAA…"} />
            {errors.token ? <div className="err">{errors.token}</div> : <div className="d">รหัสจะไม่ถูกส่งกลับมาแสดงบนหน้าจอ</div>}
          </div>
          <div className="env-grid">{MAIN.map(field)}</div>
          <details className="env-adv">
            <summary>ตั้งค่าขั้นสูง (ปกติไม่ต้องแตะ)</summary>
            <div className="env-grid" style={{ marginTop: 10 }}>
              {ADVANCED.map(field)}
              <div className="field">
                <label htmlFor="env-secret">
                  รหัสส่งผลเข้า Dashboard{" "}
                  <span className={`pill ${env.secret.set ? "ok" : "warn"}`}>{env.secret.set ? `ใส่แล้ว · …${env.secret.last4}` : "ยังไม่ได้ใส่"}</span>
                </label>
                <input id="env-secret" className={`input${errors.secret ? " invalid" : ""}`} type="password" autoComplete="off" value={secret}
                  onChange={(e) => setSecret(e.target.value)} placeholder="เว้นว่าง = ใช้ค่าเดิม" />
                {errors.secret && <div className="err">{errors.secret}</div>}
              </div>
            </div>
          </details>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={save} disabled={busy !== ""}>{busy === "save" ? "กำลังบันทึกและตรวจ…" : "บันทึกแล้วตรวจสิทธิ์"}</button>
            <button className="btn" onClick={load} disabled={busy !== ""}>ยกเลิกการแก้</button>
          </div>
        </>
      )}

      {msg && <div className={`msg ${msg.ok ? "ok" : "no"}`}>{msg.ok ? "✓ " : "✕ "}{msg.text}</div>}
      {status && (
        <>
          <div className={`msg ${status.configured ?? status.ready ? "ok" : "no"}`}>
            {status.error ? `✕ ตรวจสิทธิ์ไม่ได้: ${status.error}` : `${status.configured ?? status.ready ? "✓" : "✕"} ${status.reason ?? ""}`}
          </div>
          {status.checks && status.checks.length > 0 && (
            <ul className="checks">
              {status.checks.map((c) => (
                <li key={c.key ?? c.label}>
                  <span className={`ic ${c.ok ? "ok" : "no"}`}>{c.ok ? "✓" : "✕"}</span>
                  <span>{c.label}<div className="d">{c.detail}</div></span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
