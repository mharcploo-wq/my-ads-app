import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { isLocalRequest, runCreator } from "@/lib/creator";
import { getInsights, isRange, isWho, summaryInput } from "@/lib/insights";
import type { AiSummary } from "@/lib/insightsTypes";

export const dynamic = "force-dynamic";

/** ปุ่ม ✨ ให้ Claude สรุป — POST {range, who}
 *  ใช้ตัวเลขชุดเดียวกับที่หน้าจอแสดง (จาก cache) · ส่งให้ server.py ของ agent claude ผ่านไฟล์ชั่วคราว
 *  ส่งไปเฉพาะตัวเลขสรุป ไม่มี token · กดเองเท่านั้น (ไม่รันอัตโนมัติ) */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { range?: string; who?: string } | null;
  const range = body?.range ?? "", who = body?.who ?? "";
  if (!isRange(range) || !isWho(who)) return NextResponse.json({ ok: false, error: "ช่วงเวลาหรือตัวกรองไม่ถูกต้อง" }, { status: 400 });
  const data = await getInsights(range, who, false);
  if (!data.ok) return NextResponse.json({ ok: false, error: data.error }, { status: 502 });
  if (!data.period) return NextResponse.json({ ok: false, error: "ช่วงนี้ยังไม่มีค่าใช้จ่าย — ไม่มีอะไรให้สรุป" }, { status: 400 });

  const tmp = path.join(os.tmpdir(), `ads-insights-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = path.join(tmp, "summary.json");
    await fs.writeFile(file, JSON.stringify(summaryInput(data)), "utf8");
    const result = await runCreator<AiSummary>("claude", ["--insights-summary-json", file], 120_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
