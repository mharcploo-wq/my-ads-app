import { NextResponse } from "next/server";
import { startCopy } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม ✨ คิดความสนใจ + คำโฆษณา 5 ชุด — Claude อ่านแอดคู่แข่ง + ผลสรุปล่าสุด แล้วค้นคลังความสนใจของ Meta (อ่านอย่างเดียว ไม่สร้างอะไรบน Meta) · ตอบทันที */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await startCopy();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
