import { NextResponse } from "next/server";
import { resolvePage } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ＋ เพิ่มคู่แข่ง — POST { query } ชื่อเพจ / page_id / ลิงก์ → เพจที่เจอใน Ad Library ให้เลือก (ยังไม่บันทึก) */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { query?: unknown };
  const r = await resolvePage(String(b.query ?? ""));
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
