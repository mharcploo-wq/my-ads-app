import { NextResponse } from "next/server";
import { setBriefingPage } from "@/lib/briefing";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ช่องเลือกเพจที่หัวการ์ดพอร์ต — POST { account, page } → จำเพจที่เลือก แล้วดึงใหม่เฉพาะพอร์ตนั้น
 *  มีผลแค่หน้า Daily Briefing (ไม่เปลี่ยนเพจประจำ Agent) · อ่าน Meta อย่างเดียว · ใช้ได้จากเครื่องนี้เท่านั้น */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { account?: unknown; page?: unknown };
  const data = await setBriefingPage(String(b.account ?? ""), String(b.page ?? ""));
  return NextResponse.json(data, { status: data.ok ? 200 : 400 });
}
