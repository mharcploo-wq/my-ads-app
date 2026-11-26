"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { COMPETITOR_MODELS, CompetitorsClaudeCheck, CompetitorsClaudeView } from "@/lib/competitorsTypes";

/** แท็บเชื่อมต่อ API → การ์ด 4 · คีย์/รุ่น Claude ของหน้าวิเคราะห์คู่แข่ง (แยกจากคีย์ของ Agent)
 *  ช่องคีย์ว่าง = ใช้คีย์ของ Agent Claude แทน · คีย์ไม่ถูกส่งกลับมาที่หน้าจอ (เห็นแค่ 4 ตัวท้าย) */

const when = (iso: string) =>
  new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function CompetitorsClaudeCard() {
  const [v, setV] = useState<CompetitorsClaudeView | null>(null);
  const [aiKey, setAiKey] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [model, setModel] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "load" | "save" | "test" | "clear">("load");
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const apply = (c: CompetitorsClaudeView) => { setV(c); setWorkspace(c.workspace); setModel(c.model); };
  const load = useCallback(async () => {
    setBusy("load");
    try {
      const r = await (await fetch("/api/competitors/claude", { cache: "no-store" })).json();
      if (r.ok) apply(r.claude);
    } finally { setBusy(""); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // มาจากลิงก์ในหน้า /competitors (#competitors-claude) → เลื่อนมาที่การ์ดนี้
  useEffect(() => {
    if (v && location.hash === "#competitors-claude") ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [v]);

  async function post(action: "save" | "test" | "clear") {
    setBusy(action); setMsg(null); setErrors({});
    try {
      const r = await (await fetch("/api/competitors/claude", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, aiKey, workspace, model }),
      })).json() as { ok: boolean; error?: string; errors?: Record<string, string>; check?: CompetitorsClaudeCheck; claude?: CompetitorsClaudeView };
      if (!r.ok) { setErrors(r.errors ?? {}); setMsg(r.error ?? "บันทึกไม่สำเร็จ"); return; }
      if (r.claude) apply(r.claude);
      if (action !== "test") setAiKey("");
    } catch (e) {
      setMsg((e as Error).message);
    } finally { setBusy(""); }
  }

  const ownUserKey = aiKey.trim() ? aiKey.trim().startsWith("sk-ant-usr-") : !!v?.own.userKey;
  const check = v?.check;
  return (
    <div className="card" id="competitors-claude" ref={ref} style={{ scrollMarginTop: 90 }}>
      <h3>4. Claude สำหรับวิเคราะห์คู่แข่ง</h3>
      <p className="hint">ใช้กับปุ่ม ✨ ในหน้า <a href="/competitors">🔍 วิเคราะห์คู่แข่ง</a> เท่านั้น · บันทึกลง <code>mcp-server/.env.competitors</code> · ไม่แตะคีย์ของ Agent</p>
      {busy === "load" && !v && <p className="hint">กำลังอ่านไฟล์ตั้งค่า…</p>}
      {v && (
        <>
          <div className="row" style={{ marginBottom: 12, alignItems: "center" }}>
            <span>ตอนนี้ใช้:</span>
            {v.using === "own" && <span className="pill ok">คีย์ของฟังก์ชันนี้ · ลงท้าย …{v.last4}</span>}
            {v.using === "agent" && <><span className="pill warn">คีย์ของ Agent Claude · ลงท้าย …{v.last4}</span><span className="hint" style={{ margin: 0 }}>(ช่องด้านล่างยังว่าง)</span></>}
            {v.using === "none" && <span className="pill bad">✕ ยังไม่มีคีย์ Claude เลย — วางคีย์ในช่องด้านล่าง</span>}
          </div>
          <div className="field">
            <label htmlFor="cc-key">
              คีย์ Claude ของฟังก์ชันนี้{" "}
              <span className={`pill ${v.own.set ? "ok" : ""}`}>{v.own.set ? `✓ ใส่แล้ว · ลงท้าย …${v.own.last4}` : "ยังไม่ได้ใส่ — ใช้คีย์ Agent Claude แทน"}</span>
            </label>
            <input id="cc-key" className={`input${errors.aiKey ? " invalid" : ""}`} type="password" autoComplete="off" value={aiKey}
              onChange={(e) => setAiKey(e.target.value)} disabled={busy !== ""}
              placeholder={v.own.set ? "เว้นว่าง = ใช้คีย์เดิม · วางใหม่เพื่อเปลี่ยน" : "วางคีย์ที่ขึ้นต้นด้วย sk-ant-…"} />
            {errors.aiKey
              ? <div className="err">{errors.aiKey}</div>
              : <div className="d">คีย์จะไม่ถูกส่งกลับมาแสดงบนหน้าจอ · สร้างคีย์ได้ที่ platform.claude.com → API Keys</div>}
          </div>
          {(ownUserKey || errors.workspace) && (
            <div className="field">
              <label htmlFor="cc-ws">
                Workspace ID{" "}
                {workspace ? <span className="pill ok">✓ ใส่แล้ว</span> : <span className="pill bad">✕ คีย์นี้ต้องใส่</span>}
              </label>
              <input id="cc-ws" className={`input${errors.workspace ? " invalid" : ""}`} value={workspace} placeholder="wrkspc_…"
                autoComplete="off" onChange={(e) => setWorkspace(e.target.value.trim())} disabled={busy !== ""} />
              {errors.workspace
                ? <div className="err">{errors.workspace}</div>
                : <div className="d">คีย์ที่ขึ้นต้นด้วย sk-ant-usr- ต้องใส่ · หาได้ที่ platform.claude.com → Settings → Workspaces</div>}
            </div>
          )}
          <div className="field">
            <label htmlFor="cc-model">รุ่น Claude</label>
            <select id="cc-model" className={`input${errors.model ? " invalid" : ""}`} style={{ maxWidth: 440 }} value={model}
              onChange={(e) => setModel(e.target.value)} disabled={busy !== ""}>
              {COMPETITOR_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {errors.model && <div className="err">{errors.model}</div>}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => post("save")} disabled={busy !== ""}>{busy === "save" ? "กำลังบันทึกและทดสอบ…" : "บันทึก"}</button>
            <button className="btn" onClick={() => post("test")} disabled={busy !== "" || v.using === "none"}>{busy === "test" ? "กำลังทดสอบ…" : "🔌 ทดสอบการเชื่อมต่อ"}</button>
            <button className="btn" onClick={() => post("clear")} disabled={busy !== "" || !v.own.set}>{busy === "clear" ? "กำลังล้าง…" : "ล้างคีย์ (กลับไปใช้ Agent Claude)"}</button>
          </div>
          {msg && <div className="msg no">✕ {msg}</div>}
          {check && !msg && (
            <div className={`msg ${check.ok ? "ok" : "no"}`}>{check.ok ? "✓" : "✕"} {check.text} · ตรวจเมื่อ {when(check.at)}</div>
          )}
          <p className="hint" style={{ marginBottom: 0 }}>ปุ่มทดสอบแค่ถามข้อมูลรุ่นจาก Anthropic (ไม่เสียค่าโทเคน) · กด ✨ สรุปในหน้าคู่แข่งถึงจะเสียค่า API ตามรุ่นที่เลือก</p>
        </>
      )}
    </div>
  );
}
