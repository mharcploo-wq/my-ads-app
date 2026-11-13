"use client";
import type { PortfolioCheck } from "@/lib/creator";

/** พอร์ตโฟลิโอเพิ่มเติม (พอร์ต 2–5) ของ agent — แต่ละพอร์ตใช้ token ของ system user ในพอร์ตนั้น
 *  ค่าเก็บใน .env.{agent} เป็น META_PORTFOLIO_{n}_* · token ไม่ถูกส่งกลับมาที่หน้าเว็บ (เห็นแค่ 4 ตัวท้าย) */
export type PfKey = "AD_ACCOUNT_ID" | "PAGE_ID" | "PIXEL_ID" | "VERIFIED_IDENTITY_ID";
export interface PfRow {
  slot: number;
  saved: boolean;                                 // มีอยู่ในไฟล์แล้ว
  tokenInfo: { set: boolean; last4: string | null } | null;
  token: string;                                  // token ใหม่ที่พิมพ์ (ว่าง = ใช้ค่าเดิม)
  values: Record<PfKey, string>;
  remove: boolean;                                // กดลบแล้ว (ลบจริงตอนบันทึก)
  check: PortfolioCheck | null;
  checking: boolean;
  checkErr: string | null;
}
export const PF_SLOTS = [2, 3, 4, 5];
export const blankValues = (): Record<PfKey, string> => ({ AD_ACCOUNT_ID: "", PAGE_ID: "", PIXEL_ID: "", VERIFIED_IDENTITY_ID: "" });

export default function PortfolioSlots({ rows, agentLabel, errors, disabled, onChange, onCheck }: {
  rows: PfRow[];
  agentLabel: string;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (slot: number, patch: Partial<PfRow>) => void;
  onCheck: (slot: number) => void;
}) {
  const live = rows.filter((r) => !r.remove);
  const free = PF_SLOTS.filter((n) => !rows.some((r) => r.slot === n && !r.remove));
  const add = () => {
    const n = free[0];
    if (!n) return;
    const old = rows.find((r) => r.slot === n);
    if (old) onChange(n, { remove: false });
    else onChange(n, { slot: n, saved: false, tokenInfo: null, token: "", values: blankValues(), remove: false, check: null, checking: false, checkErr: null });
  };

  return (
    <div className="pf-box">
      <div className="pf-h">
        <b>พอร์ตโฟลิโอเพิ่มเติม</b>
        <span className="d">สูงสุด {PF_SLOTS.length} พอร์ต · token แยกต่อ agent · ช่องเดิมข้างบน = พอร์ตหลัก</span>
      </div>
      {!live.length && <div className="d">ยังไม่มี — กด ＋ แล้ววาง token ของ system user ในพอร์ตโฟลิโออื่น (เช่น Charoen Food and Beverage) ของ {agentLabel}</div>}
      {live.map((r) => <Slot key={r.slot} r={r} errors={errors} disabled={disabled} onChange={onChange} onCheck={onCheck} />)}
      {free.length > 0 && <button type="button" className="btn" onClick={add} disabled={disabled}>＋ เพิ่มพอร์ตโฟลิโอ</button>}
    </div>
  );
}

function Slot({ r, errors, disabled, onChange, onCheck }: {
  r: PfRow; errors: Record<string, string>; disabled: boolean;
  onChange: (slot: number, patch: Partial<PfRow>) => void; onCheck: (slot: number) => void;
}) {
  const e = (k: string) => errors[`pf${r.slot}.${k}`];
  const set = (k: PfKey, v: string) => onChange(r.slot, { values: { ...r.values, [k]: v } });
  const c = r.check;
  const acc = c?.accounts.find((a) => a.id === r.values.AD_ACCOUNT_ID) ?? null;
  const name = c?.business ?? acc?.business ?? null;
  const accLost = !!c?.success && !!r.values.AD_ACCOUNT_ID && !acc;
  const pageLost = !!c?.pages.length && !!r.values.PAGE_ID && !c.pages.some((p) => p.id === r.values.PAGE_ID);
  const id = (k: string) => `pf${r.slot}-${k}`;

  return (
    <div className="pf-slot">
      <div className="pf-slot-h">
        <b>พอร์ต {r.slot} · {name ?? "(ยังไม่รู้ชื่อ — กดตรวจ token)"}</b>
        <button type="button" className="btn" disabled={disabled} onClick={() => onChange(r.slot, { remove: true })}>ลบพอร์ตนี้</button>
      </div>
      <div className="env-grid">
        <div className="field">
          <label htmlFor={id("token")}>
            Token (system user ในพอร์ตนี้){" "}
            <span className={`pill ${r.tokenInfo?.set ? "ok" : "bad"}`}>{r.tokenInfo?.set ? `✓ ใส่แล้ว · ลงท้าย …${r.tokenInfo.last4}` : "✕ ยังไม่ได้ใส่"}</span>
          </label>
          <input id={id("token")} className={`input${e("TOKEN") ? " invalid" : ""}`} type="password" autoComplete="off" value={r.token}
            onChange={(ev) => onChange(r.slot, { token: ev.target.value.trim(), check: null, checkErr: null })}
            placeholder={r.tokenInfo?.set ? "เว้นว่าง = ใช้รหัสเดิม · วางใหม่เพื่อเปลี่ยน" : "วางรหัสที่ขึ้นต้นด้วย EAA…"} />
          {e("TOKEN") ? <div className="err">{e("TOKEN")}</div> : <div className="d">รหัสจะไม่ถูกส่งกลับมาแสดงบนหน้าจอ</div>}
        </div>

        <div className="field">
          <label htmlFor={id("acc")}>บัญชีโฆษณา</label>
          {c?.accounts.length ? (
            <select id={id("acc")} className={`input${e("AD_ACCOUNT_ID") || accLost ? " invalid" : ""}`} value={r.values.AD_ACCOUNT_ID}
              onChange={(ev) => set("AD_ACCOUNT_ID", ev.target.value)}>
              <option value="">— เลือกบัญชีโฆษณา —</option>
              {accLost && <option value={r.values.AD_ACCOUNT_ID}>{r.values.AD_ACCOUNT_ID} (token นี้เข้าไม่ได้)</option>}
              {c.accounts.map((a) => (
                <option key={a.id} value={a.id} disabled={!!a.problem}>{a.name} · {a.id} · {a.currency}{a.problem ? " — เลือกไม่ได้" : ""}</option>
              ))}
            </select>
          ) : (
            <input id={id("acc")} className={`input${e("AD_ACCOUNT_ID") ? " invalid" : ""}`} value={r.values.AD_ACCOUNT_ID}
              placeholder="act_… (กดตรวจ token เพื่อเลือกจากรายการ)" onChange={(ev) => set("AD_ACCOUNT_ID", ev.target.value.trim())} />
          )}
          {e("AD_ACCOUNT_ID") ? <div className="err">{e("AD_ACCOUNT_ID")}</div>
            : accLost ? <div className="err">⚠ token นี้เข้าบัญชีที่บันทึกไว้ไม่ได้แล้ว — assign บัญชีให้ system user หรือเลือกบัญชีใหม่</div>
            : c?.accounts.some((a) => a.problem) ? <div className="d">{c.accounts.filter((a) => a.problem).map((a) => `${a.name}: ${a.problem}`).join(" · ")}</div>
            : null}
        </div>

        <div className="field">
          <label htmlFor={id("page")}>เพจประจำพอร์ตนี้</label>
          {c?.pages.length ? (
            <select id={id("page")} className={`input${e("PAGE_ID") || pageLost ? " invalid" : ""}`} value={r.values.PAGE_ID}
              onChange={(ev) => set("PAGE_ID", ev.target.value)}>
              <option value="">— เพจแรกในรายการ —</option>
              {pageLost && <option value={r.values.PAGE_ID}>เลข {r.values.PAGE_ID} (ไม่อยู่ในรายการ)</option>}
              {c.pages.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}
            </select>
          ) : (
            <input id={id("page")} className={`input${e("PAGE_ID") ? " invalid" : ""}`} value={r.values.PAGE_ID}
              placeholder="เลขเพจ (เว้นว่างได้)" onChange={(ev) => set("PAGE_ID", ev.target.value.trim())} />
          )}
          {e("PAGE_ID") && <div className="err">{e("PAGE_ID")}</div>}
        </div>

        <div className="field">
          <label htmlFor={id("pixel")}>Pixel</label>
          <input id={id("pixel")} className={`input${e("PIXEL_ID") ? " invalid" : ""}`} value={r.values.PIXEL_ID}
            placeholder={`เว้นว่าง = ดึงจากบัญชีโฆษณา${acc ? (acc.pixel ? ` (เจอ ${acc.pixel})` : " (ไม่เจอ)") : ""}`}
            onChange={(ev) => set("PIXEL_ID", ev.target.value.trim())} />
          {e("PIXEL_ID") && <div className="err">{e("PIXEL_ID")}</div>}
        </div>

        <div className="field">
          <label htmlFor={id("vid")}>เลขผู้ลงโฆษณาที่ยืนยันตัวตน</label>
          <input id={id("vid")} className={`input${e("VERIFIED_IDENTITY_ID") ? " invalid" : ""}`} value={r.values.VERIFIED_IDENTITY_ID}
            placeholder={`เว้นว่าง = ดึงจาก Ad Set ล่าสุด${acc ? (acc.identity ? ` (เจอ ${acc.identity})` : " (ไม่เจอ)") : ""}`}
            onChange={(ev) => set("VERIFIED_IDENTITY_ID", ev.target.value.trim())} />
          {e("VERIFIED_IDENTITY_ID") && <div className="err">{e("VERIFIED_IDENTITY_ID")}</div>}
        </div>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="btn" disabled={disabled || r.checking || (!r.token && !r.tokenInfo?.set)} onClick={() => onCheck(r.slot)}>
          {r.checking ? "กำลังตรวจ…" : "↻ ตรวจ token"}
        </button>
        <span className="d">ชื่อพอร์ต · บัญชี · เพจ ดึงจาก Meta หลังกดตรวจ · ยังไม่บันทึกจนกว่าจะกด "บันทึกแล้วตรวจสิทธิ์"</span>
      </div>
      {r.checkErr && <div className="msg no">✕ {r.checkErr}</div>}
      {c && !c.success && <div className="msg no">✕ {c.error}</div>}
      {c?.success && (
        <div className={`msg ${c.no_account ? "no" : "ok"}`}>
          {c.no_account
            ? <>⚠ token ใช้ได้ ({c.user}) แต่ยังไม่มีบัญชีโฆษณาที่ token นี้เข้าถึง<br />
                ทำใน Business Settings ของพอร์ตนั้น: ① สร้างบัญชีโฆษณา (สกุลเงิน THB) ② System users → Assign assets → บัญชีโฆษณา + เพจ (สิทธิ์จัดการ) แล้วกด ↻ ตรวจ token<br />
                บันทึกได้ แต่พอร์ตนี้จะเลือกไม่ได้ในฟอร์มจนกว่าจะมีบัญชี</>
            : <>✓ token ใช้ได้ ({c.user}) · บัญชีโฆษณา {c.accounts.length} · เพจที่ลงโฆษณาได้ {c.pages.length}</>}
        </div>
      )}
    </div>
  );
}
