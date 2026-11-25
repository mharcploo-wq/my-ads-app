import { NextResponse } from "next/server";
import { getSchedule, setSchedule } from "@/lib/briefingSchedule";
import { isLocalRequest } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ตั้งเวลาอัปเดตหน้า Daily Briefing — GET ดูสถานะ · POST { enabled?, time? "HH:MM" } · ใช้ได้จากเครื่องนี้เท่านั้น */
const local = (req: Request) => (isLocalRequest(req) ? null : NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 }));

export async function GET(req: Request) {
  return local(req) ?? NextResponse.json({ ok: true, schedule: await getSchedule() });
}

export async function POST(req: Request) {
  const denied = local(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; time?: unknown };
    return NextResponse.json({ ok: true, schedule: await setSchedule(body) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
