import { NextResponse } from "next/server";
import { startKeywordIdeas } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม ✨ ให้ Claude คิดคำค้น — เริ่มงานเบื้องหลัง ตอบทันที (หน้าเว็บถามผลทุก 3 วิ) · ไม่มีธุรกิจ/มีงานค้าง = 409 */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await startKeywordIdeas();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
