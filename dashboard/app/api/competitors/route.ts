import { NextResponse } from "next/server";
import { getCompetitors, saveConfig } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** หน้าวิเคราะห์คู่แข่ง — GET = ค่าตั้ง + ผลสแกนล่าสุด + งานที่กำลังทำ (หน้าเว็บถามซ้ำระหว่างสแกน)
 *  POST { business?, competitors?, keywords? } = บันทึกค่าตั้ง · ใช้ได้จากเครื่องนี้เท่านั้น */
export async function GET() {
  return NextResponse.json({ ok: true, state: await getCompetitors() });
}

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await saveConfig(b);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
