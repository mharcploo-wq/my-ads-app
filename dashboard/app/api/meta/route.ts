import { NextResponse } from "next/server";
import { pullFromMeta, testMeta } from "@/lib/meta";
import { upsert } from "@/lib/store";

export const dynamic = "force-dynamic";

/** POST { action: "test" } หรือ { action: "sync", date_preset } — โทเคนอยู่ฝั่ง server เท่านั้น */
export async function POST(req: Request) {
  const { action, date_preset } = (await req.json().catch(() => ({}))) as { action?: string; date_preset?: string };
  if (action === "test") return NextResponse.json(await testMeta());
  if (action === "sync") {
    const r = await pullFromMeta(date_preset ?? "last_7d");
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
    const res = await upsert(r.payload!, "meta");
    return NextResponse.json({ ok: true, ...res });
  }
  return NextResponse.json({ ok: false, error: "action ต้องเป็น test หรือ sync" }, { status: 400 });
}
