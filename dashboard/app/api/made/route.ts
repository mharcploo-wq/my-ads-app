import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/creator";
import { clearMade, readMade } from "@/lib/made";

export const dynamic = "force-dynamic";

/** แคมเปญที่สร้างจากชุดความสนใจของแต่ละ AI (กันสร้างซ้ำ) — GET อ่าน · DELETE ล้าง (ปุ่มรีเซ็ตฟอร์ม) */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  return NextResponse.json({ ok: true, made: await readMade() });
}

export async function DELETE(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  await clearMade();
  return NextResponse.json({ ok: true });
}
