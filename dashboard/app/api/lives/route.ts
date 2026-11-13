import { NextResponse } from "next/server";
import { isAgentId, isLocalRequest, LivesResult, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** Live ที่นัดไว้ล่วงหน้าบนเพจของ agent นี้ (ยังไม่เริ่ม เรียงจากใกล้สุด) — ?agent=claude&page_id=… (ว่าง = เพจประจำ agent) */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const agent = q.get("agent") ?? "";
  const pageId = q.get("page_id") ?? "";
  if (!isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือกผู้สร้างไม่ถูกต้อง" }, { status: 400 });
  try {
    const args = ["--lives", ...(/^\d+$/.test(pageId) ? ["--page-id", pageId] : [])];
    const result = await runCreator<LivesResult>(agent, args, 60_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
