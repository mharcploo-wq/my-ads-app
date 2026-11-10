import { NextResponse } from "next/server";
import { authorized, secretSet } from "@/lib/auth";
import { upsert } from "@/lib/store";
import { IngestPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/** รับข้อมูลจาก mcp-server: send_to_dashboard() */
export async function POST(req: Request) {
  if (!secretSet()) {
    return NextResponse.json(
      { ok: false, error: "ยังไม่ได้ตั้ง DASHBOARD_API_SECRET (อย่างน้อย 12 ตัวอักษร) ใน dashboard/.env.local" },
      { status: 503 },
    );
  }
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "secret ไม่ถูกต้อง" }, { status: 401 });
  let body: IngestPayload;
  try {
    body = (await req.json()) as IngestPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "body ต้องเป็น JSON" }, { status: 400 });
  }
  if (body.ping) return NextResponse.json({ ok: true, message: "เชื่อมต่อสำเร็จ — secret ถูกต้อง" });
  const res = await upsert(body, "mcp");
  return NextResponse.json({ ok: true, ...res });
}
