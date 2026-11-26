import { NextResponse } from "next/server";
import { startImages } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม 🎨 คิด prompt ภาพให้ 5 ชุด — Claude อ่านคำโฆษณา 5 ชุดล่าสุด แล้วคิด prompt ภาพ 1:1 + 9:16 (ไม่สร้างภาพ ไม่แตะ Meta) · ตอบทันที */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await startImages();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
