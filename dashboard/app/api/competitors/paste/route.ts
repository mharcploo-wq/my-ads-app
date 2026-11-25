import { NextResponse } from "next/server";
import { pasteAds } from "@/lib/competitors";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ช่องวางเอง — POST { pageId, text } ข้อความทั้งหน้า (Ctrl+A) จาก Ad Library ของเจ้านั้น → แทนผลสแกนของเจ้านั้น */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { pageId?: unknown; text?: unknown };
  const r = await pasteAds(String(b.pageId ?? ""), String(b.text ?? ""));
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
