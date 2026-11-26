import { NextResponse } from "next/server";
import { startVideos } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม 🎬 คิด prompt คลิป 16 วิ ให้ 5 ชุด — Claude อ่านคำโฆษณา + ภาพ 9:16 ล่าสุด แล้วคิดคลิป 2 ช็อต × 8 วิ (ไม่สร้างคลิป ไม่แตะ Meta) · ตอบทันที */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await startVideos();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
