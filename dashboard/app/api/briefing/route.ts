import { NextResponse } from "next/server";
import { getBriefing } from "@/lib/briefing";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** หน้า Daily Briefing — GET ?fresh=1 (ปุ่ม ↻ ดึงใหม่)
 *  อ่านอย่างเดียวจาก Meta ทุกพอร์ต (token อยู่ฝั่ง server) · ผลเก็บไว้ 10 นาที · ใช้ได้จากเครื่องนี้เท่านั้น */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const data = await getBriefing(new URL(req.url).searchParams.get("fresh") === "1");
  return NextResponse.json(data, { status: data.ok ? 200 : 502 });
}
