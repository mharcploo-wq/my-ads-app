import { NextResponse } from "next/server";
import { startFind } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม 🔍 หาคู่แข่งจากคำค้น — ค้นคำค้นใน Ad Library แล้ว Claude คัดเพจ (งานเบื้องหลัง หน้าเว็บถามผลทุก 3 วิ) · ไม่มีคำค้น/มีงานค้าง = 409 */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await startFind();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
