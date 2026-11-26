import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/creator";
import { checkCompetitorsClaude, getCompetitorsClaude, saveCompetitorsClaude } from "@/lib/competitorsClaude";
import type { CompetitorsClaudeInput } from "@/lib/competitorsTypes";

export const dynamic = "force-dynamic";

/** การ์ด "Claude สำหรับวิเคราะห์คู่แข่ง" — อ่านสถานะ (ไม่มีคีย์เต็ม) */
export async function GET() {
  return NextResponse.json({ ok: true, claude: await getCompetitorsClaude() });
}

/** action: save (บันทึก แล้วทดสอบให้เลย) · clear (ล้างคีย์ กลับไปใช้ Agent Claude) · test (ทดสอบอย่างเดียว) */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as ({ action?: string } & Partial<CompetitorsClaudeInput>) | null;
  const action = body?.action;
  if (action === "save" || action === "clear") {
    const r = await saveCompetitorsClaude({
      aiKey: typeof body?.aiKey === "string" ? body.aiKey : "",
      workspace: typeof body?.workspace === "string" ? body.workspace : "",
      model: typeof body?.model === "string" ? body.model : "",
      clear: action === "clear",
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: "ตรวจช่องที่ขึ้นสีแดง", errors: r.errors }, { status: 400 });
  } else if (action !== "test") {
    return NextResponse.json({ ok: false, error: "คำสั่งไม่ถูกต้อง" }, { status: 400 });
  }
  const check = await checkCompetitorsClaude();
  return NextResponse.json({ ok: true, check, claude: await getCompetitorsClaude() });
}
