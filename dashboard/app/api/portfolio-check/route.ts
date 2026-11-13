import { NextResponse } from "next/server";
import { isAgentId, isLocalRequest, portfolioArgs, portfolioOf, PortfolioCheck, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม "↻ ตรวจ token" ของพอร์ตโฟลิโอ — POST {agent, slot, token?}
 *  token ใหม่ส่งให้ server.py ทาง env (ไม่อยู่บนบรรทัดคำสั่ง ไม่ถูกบันทึก) · ว่าง = ตรวจ token ที่บันทึกไว้ของพอร์ตนั้น */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { agent?: string; slot?: unknown; token?: unknown } | null;
  const agent = body?.agent ?? "";
  if (!isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือก Agent ไม่ถูกต้อง" }, { status: 400 });
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (token && !/^EAA[A-Za-z0-9]{20,}$/.test(token))
    return NextResponse.json({ ok: false, error: "รหัสต้องขึ้นต้นด้วย EAA และไม่มีช่องว่าง" }, { status: 400 });
  try {
    const result = await runCreator<PortfolioCheck>(agent, ["--check-portfolio", ...portfolioArgs(portfolioOf(body?.slot))],
      60_000, token ? { PORTFOLIO_CHECK_TOKEN: token } : {});
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
