"use client";
import { useCallback, useEffect, useState } from "react";
import { AGENTS, Prefix, PREFIXES } from "@/lib/types";
import type { AdPage, Portfolio, PortfolioCheck } from "@/lib/creator";
import PortfolioSlots, { PfKey, PfRow } from "@/components/PortfolioSlots";

type Values = Record<string, string>;
type SecretInfo = { set: boolean; last4: string | null };
type EnvView = {
  agent: string; prefix: string; file: string; exists: boolean; values: Values; token: SecretInfo; secret: SecretInfo;
  aiKey: SecretInfo & { name: string; label: string; workspace: boolean; hint: string; userKey: boolean };
  portfolios: { slot: number; token: SecretInfo; values: Record<PfKey, string> }[];
};
type Check = { key: string; label: string; ok: boolean; detail: string; warn?: boolean };
type Status = { ready?: boolean; configured?: boolean; reason?: string; checks?: Check[]; error?: string; portfolios?: Portfolio[] | null };

const rowsOf = (env: EnvView): PfRow[] => env.portfolios.map((p) => ({
  slot: p.slot, saved: true, tokenInfo: p.token, token: "", values: p.values, remove: false,
  check: null, checking: false, checkErr: null,
}));

const MAIN: { key: string; label: string; hint?: string; num?: boolean }[] = [
  { key: "META_AD_ACCOUNT_ID", label: "บัญชีโฆษณา", hint: "act_ ตามด้วยตัวเลข" },
  { key: "META_PAGE_ID", label: "เพจประจำ agent" },
  { key: "MAX_DAILY_BUDGET_THB", label: "งบสูงสุดต่อวัน (บาท) · ไม่เกิน 1,000", num: true },
  { key: "MAX_CAMPAIGNS_PER_DAY", label: "แคมเปญสูงสุดต่อวัน · ไม่เกิน 5", num: true },
  { key: "META_PIXEL_ID", label: "Pixel (เว้นว่างได้)" },
  { key: "META_VERIFIED_IDENTITY_ID", label: "เลขผู้ลงโฆษณาที่ยืนยันตัวตน" },
];
const ADVANCED: { key: string; label: string }[] = [
  { key: "GRAPH_API_VERSION", label: "เวอร์ชัน Graph API" },
  { key: "DASHBOARD_API_URL", label: "ที่อยู่ส่งผลเข้า Dashboard" },
  { key: "AI_MODEL", label: "รุ่น AI ของปุ่ม ✨ (เว้นว่าง = ค่าเริ่มต้น)" },
];

/** การ์ด "3. ตั้งค่า Agent" — กรอกแล้วบันทึกลง mcp-server/.env.{agent} แล้วตรวจสิทธิ์ทันที */
export default function AgentEnvForm() {
  const [agent, setAgent] = useState<Prefix>("CLD-");
  const key = AGENTS[agent].key;
  const [env, setEnv] = useState<EnvView | null>(null);
  const [values, setValues] = useState<Values>({});
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "load" | "save">("load");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  // เพจที่ Token ลงโฆษณาได้ (ดึงจาก Meta) — มีรายการ = ช่องเพจเป็นรายการเลือก · ไม่มี = พิมพ์เลขเพจเหมือนเดิม
  const [pages, setPages] = useState<AdPage[] | null>(null);
  const [pagesErr, setPagesErr] = useState<string | null>(null);
  // พอร์ตโฟลิโอเพิ่มเติม (พอร์ต 2–5)
  const [pfRows, setPfRows] = useState<PfRow[]>([]);
  const patchRow = (slot: number, patch: Partial<PfRow>) => setPfRows((rows) =>
    rows.some((r) => r.slot === slot) ? rows.map((r) => (r.slot === slot ? { ...r, ...patch } : r))
      : [...rows, patch as PfRow].sort((a, b) => a.slot - b.slot));

  /** ปุ่ม ↻ ตรวจ token — token ที่พิมพ์ไว้ (ยังไม่บันทึก) หรือ token ที่บันทึกไว้ของพอร์ตนั้น */
  const checkRow = useCallback(async (slot: number, token: string) => {
    patchRow(slot, { checking: true, checkErr: null });
    try {
      const r = await fetch("/api/portfolio-check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: key, slot, token }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      const c = j.result as PortfolioCheck;
      setPfRows((rows) => rows.map((x) => {
        if (x.slot !== slot) return x;
        // มีบัญชีที่ใช้ได้บัญชีเดียวและยังไม่ได้เลือก → เลือกให้เลย
        const usable = c.accounts.filter((a) => !a.problem);
        const values = !x.values.AD_ACCOUNT_ID && usable.length === 1 ? { ...x.values, AD_ACCOUNT_ID: usable[0].id } : x.values;
        return { ...x, check: c, checking: false, values };
      }));
    } catch (e) {
      patchRow(slot, { checking: false, checkErr: (e as Error).message });
    }
  }, [key]);

  const loadPages = useCallback(async () => {
    setPages(null); setPagesErr(null);
    try {
      const r = await fetch(`/api/pages?agent=${key}`, { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      if (!j.result.success) throw new Error(j.result.error);
      setPages(j.result.pages);
    } catch (e) {
      setPagesErr((e as Error).message);
    }
  }, [key]);

  const load = useCallback(async () => {
    setBusy("load");
    setMsg(null); setStatus(null); setErrors({}); setToken(""); setSecret(""); setAiKey("");
    try {
      const r = await fetch(`/api/agent-env?agent=${key}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setEnv(j.env);
      setValues(j.env.values);
      setPfRows(rowsOf(j.env));
      (j.env as EnvView).portfolios.filter((p) => p.token.set).forEach((p) => checkRow(p.slot, ""));
      if (j.env.token.set) loadPages(); else { setPages(null); setPagesErr(null); }
    } catch (e) {
      setEnv(null);
      setMsg({ ok: false, text: `อ่านไฟล์ตั้งค่าไม่ได้: ${(e as Error).message}` });
    } finally {
      setBusy("");
    }
  }, [key, loadPages, checkRow]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy("save");
    setMsg(null); setStatus(null); setErrors({});
    try {
      const r = await fetch("/api/agent-env", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: key, values, token, secret, aiKey,
          // พอร์ตที่เพิ่มแล้วลบก่อนบันทึก = ไม่ต้องส่ง · พอร์ตในไฟล์ที่กดลบ = remove
          portfolios: pfRows.filter((r) => r.saved || !r.remove)
            .map((r) => ({ slot: r.slot, token: r.token, values: r.values, remove: r.remove })),
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErrors(j.errors ?? {});
        setMsg({ ok: false, text: j.error ?? `บันทึกไม่สำเร็จ (HTTP ${r.status})` });
        return;
      }
      setEnv(j.env);
      setValues(j.env.values);
      // คงผลตรวจ token เดิมไว้ (รายการบัญชี/เพจ) — token ที่พิมพ์ไว้ถูกบันทึกแล้วจึงล้างช่อง
      setPfRows((old) => rowsOf(j.env).map((r) => ({ ...r, check: old.find((o) => o.slot === r.slot)?.check ?? null })));
      setToken(""); setSecret(""); setAiKey("");
      setStatus(j.status);
      if (j.env.token.set) loadPages();
      setMsg({ ok: true, text: `บันทึกลง ${j.env.file} แล้ว` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const field = (f: { key: string; label: string; hint?: string; num?: boolean }) => f.key === "META_PAGE_ID" && pages?.length ? pageField(f.label) : (
    <div className="field" key={f.key}>
      <label htmlFor={`env-${f.key}`}>{f.label}</label>
      <input id={`env-${f.key}`} className={`input${errors[f.key] ? " invalid" : ""}`} value={values[f.key] ?? ""}
        inputMode={f.num ? "numeric" : undefined} placeholder={f.hint}
        onChange={(e) => set(f.key, e.target.value)} />
      {errors[f.key] && <div className="err">{errors[f.key]}</div>}
    </div>
  );

  /** เพจประจำ agent เป็นรายการเลือก — เพจที่บันทึกไว้แต่หลุดจากรายการ (Token เสียสิทธิ์) ยังโชว์ไว้พร้อมเตือน */
  const pageField = (label: string) => {
    const v = values.META_PAGE_ID ?? "";
    const lost = !!v && !pages!.some((p) => p.id === v);
    return (
      <div className="field" key="META_PAGE_ID">
        <label htmlFor="env-META_PAGE_ID">{label}</label>
        <select id="env-META_PAGE_ID" className={`input${errors.META_PAGE_ID || lost ? " invalid" : ""}`} value={v}
          onChange={(e) => set("META_PAGE_ID", e.target.value)}>
          {!v && <option value="">— เลือกเพจ —</option>}
          {lost && <option value={v}>เลข {v} (ไม่อยู่ในรายการ)</option>}
          {pages!.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}
        </select>
        {errors.META_PAGE_ID ? <div className="err">{errors.META_PAGE_ID}</div>
          : lost ? <div className="err">⚠ เพจที่บันทึกไว้ไม่อยู่ในรายการแล้ว — Token อาจเสียสิทธิ์เพจนี้ · เลือกเพจใหม่แล้วกดบันทึก</div>
          : <div className="d">รายการมาจากเพจที่ Token ของ agent นี้ลงโฆษณาได้ · เปลี่ยน Token แล้วกดบันทึกก่อน รายการจะอัปเดต</div>}
      </div>
    );
  };

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
          <div className="field">
            <label htmlFor="env-aikey">
              คีย์ AI ({env.aiKey.label}) สำหรับปุ่ม ✨ ให้ AI คิดกลุ่มเป้าหมาย{" "}
              <span className={`pill ${env.aiKey.set ? "ok" : "warn"}`}>{env.aiKey.set ? `✓ ใส่แล้ว · ลงท้าย …${env.aiKey.last4}` : "ยังไม่ได้ใส่ (ไม่บังคับ)"}</span>
            </label>
            <input id="env-aikey" className={`input${errors.aiKey ? " invalid" : ""}`} type="password" autoComplete="off" value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              placeholder={env.aiKey.set ? "เว้นว่าง = ใช้คีย์เดิม · วางใหม่เพื่อเปลี่ยน" : env.aiKey.hint} />
            {errors.aiKey ? <div className="err">{errors.aiKey}</div> : <div className="d">บันทึกเป็น {env.aiKey.name} · คีย์จะไม่ถูกส่งกลับมาแสดงบนหน้าจอ</div>}
          </div>
          {env.aiKey.workspace && (
            <div className="field">
              <label htmlFor="env-ANTHROPIC_WORKSPACE_ID">
                Workspace ID ของ Claude{" "}
                {env.aiKey.userKey && !env.values.ANTHROPIC_WORKSPACE_ID
                  ? <span className="pill bad">✕ คีย์นี้ต้องใส่</span>
                  : <span className="pill">{env.aiKey.userKey ? "✓ ใส่แล้ว" : "ไม่บังคับ"}</span>}
              </label>
              <input id="env-ANTHROPIC_WORKSPACE_ID" className={`input${errors.ANTHROPIC_WORKSPACE_ID ? " invalid" : ""}`}
                value={values.ANTHROPIC_WORKSPACE_ID ?? ""} placeholder="wrkspc_…" autoComplete="off"
                onChange={(e) => set("ANTHROPIC_WORKSPACE_ID", e.target.value.trim())} />
              {errors.ANTHROPIC_WORKSPACE_ID
                ? <div className="err">{errors.ANTHROPIC_WORKSPACE_ID}</div>
                : <div className="d">ต้องใส่เมื่อคีย์ขึ้นต้นด้วย sk-ant-usr- (คีย์ระดับผู้ใช้) · หาได้ที่ platform.claude.com → Settings → Workspaces</div>}
            </div>
          )}
          <div className="env-grid">{MAIN.map(field)}</div>
          {pagesErr && <div className="d" style={{ marginTop: 6 }}>อ่านรายการเพจจาก Meta ไม่ได้ ({pagesErr}) — พิมพ์เลขเพจเองไปก่อน</div>}
          <PortfolioSlots rows={pfRows} agentLabel={AGENTS[agent].label} errors={errors} disabled={busy !== ""}
            onChange={patchRow} onCheck={(slot) => checkRow(slot, pfRows.find((r) => r.slot === slot)?.token ?? "")} />
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
                  <span className={`ic ${c.ok ? "ok" : c.warn ? "warn" : "no"}`}>{c.ok ? "✓" : c.warn ? "⚠" : "✕"}</span>
                  <span>{c.label}<div className="d">{c.detail}</div></span>
                </li>
              ))}
              {(status.portfolios ?? []).filter((p) => !p.main).map((p) => (
                <li key={`pf${p.slot}`}>
                  <span className={`ic ${p.ok ? "ok" : "no"}`}>{p.ok ? "✓" : "✕"}</span>
                  <span>พอร์ต {p.slot} · {p.name}
                    <div className="d">{p.ok ? `บัญชี ${p.account?.name} (${p.account?.id}) · เลือกยิงได้ในฟอร์มสร้างโฆษณา` : p.reason}</div></span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
