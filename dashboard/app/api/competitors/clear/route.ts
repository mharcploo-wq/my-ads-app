import { NextResponse } from "next/server";
import { clearResults } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม 🗑 ล้างข้อมูล — ลบผลสแกน/สรุป/คำโฆษณา · เก็บธุรกิจ คู่แข่ง คำค้นไว้ · มีงานค้าง = 409 */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await clearResults();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
