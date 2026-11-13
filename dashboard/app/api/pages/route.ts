import { NextResponse } from "next/server";
import { isAgentId, isLocalRequest, PagesResult, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** เพจที่ Token ของ agent นี้ลงโฆษณาได้ (server.py ดึงจาก Meta สด ๆ) — ?agent=claude
 *  ใช้กับช่อง "เพจประจำ agent" ในหน้าเชื่อมต่อ API */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const agent = new URL(req.url).searchParams.get("agent") ?? "";
  if (!isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือก Agent ไม่ถูกต้อง" }, { status: 400 });
  try {
    const result = await runCreator<PagesResult>(agent, ["--pages"], 60_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
