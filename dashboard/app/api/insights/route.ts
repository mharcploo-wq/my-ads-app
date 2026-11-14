import { NextResponse } from "next/server";
import { getInsights, isRange, isWho } from "@/lib/insights";
import { DEFAULT_RANGE } from "@/lib/insightsTypes";

export const dynamic = "force-dynamic";

/** หน้า "วิเคราะห์โฆษณา" — GET ?range=last_30d&who=all&account=act_…&fresh=1
 *  อ่านอย่างเดียวจาก Meta (token อยู่ฝั่ง server) · ผลเก็บไว้ 10 นาที · fresh=1 = ปุ่ม ↻ ดึงใหม่
 *  account = พอร์ตที่เลือก (ว่าง / ไม่อยู่ในรายการ = พอร์ตหลัก) */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const range = u.searchParams.get("range") ?? DEFAULT_RANGE;
  const who = u.searchParams.get("who") ?? "all";
  if (!isRange(range)) return NextResponse.json({ ok: false, error: "ช่วงเวลาไม่ถูกต้อง" }, { status: 400 });
  if (!isWho(who)) return NextResponse.json({ ok: false, error: "ตัวกรองแคมเปญไม่ถูกต้อง" }, { status: 400 });
  const account = u.searchParams.get("account") ?? "";
  if (account && !/^act_\d+$/.test(account)) return NextResponse.json({ ok: false, error: "บัญชีโฆษณาไม่ถูกต้อง" }, { status: 400 });
  const data = await getInsights(range, who, u.searchParams.get("fresh") === "1", account);
  return NextResponse.json(data, { status: data.ok ? 200 : 502 });
}
