import { NextResponse } from "next/server";
import { startSummary } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม ✨ สรุปใหม่ — ให้ Claude สรุปจากผลสแกน/ข้อความที่วางไว้ล่าสุด (ไม่สแกนใหม่) · ตอบทันที */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const r = await startSummary();
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}
