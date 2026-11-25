import { NextResponse } from "next/server";
import { startScan } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม 🔄 สแกน — เริ่มสแกน Ad Library เบื้องหลัง (ทีละเจ้า แล้ว Claude สรุปต่อ) · ตอบทันที ไม่รอให้เสร็จ */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await startScan();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
