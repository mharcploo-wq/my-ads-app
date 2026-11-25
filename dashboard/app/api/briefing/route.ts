import { NextResponse } from "next/server";
import { getBriefing } from "@/lib/briefing";
import { scheduleKeepsSnapshot } from "@/lib/briefingSchedule";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** หน้า Daily Briefing — GET ?fresh=1 (ปุ่ม ↻ ดึงใหม่)
 *  อ่านอย่างเดียวจาก Meta ทุกพอร์ต (token อยู่ฝั่ง server) · ผลเก็บไว้ 10 นาที (เปิดตั้งเวลาไว้ = ใช้ชุดที่อัปเดตไว้ของวันนี้) · ใช้ได้จากเครื่องนี้เท่านั้น */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const data = await getBriefing(fresh ? "fresh" : "open", await scheduleKeepsSnapshot());
  return NextResponse.json(data, { status: data.ok ? 200 : 502 });
}
