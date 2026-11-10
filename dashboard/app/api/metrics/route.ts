import { NextResponse } from "next/server";
import { authorized, secretSet } from "@/lib/auth";
import { demoData } from "@/lib/demo";
import { metaConfig } from "@/lib/meta";
import { clearStore, readStore } from "@/lib/store";
import { MetricsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await readStore();
  const rows = Object.values(s.rows);
  const campaigns = Object.values(s.campaigns);
  const demo = rows.length === 0 && campaigns.length === 0;
  const d = demo ? demoData() : { rows, campaigns };
  const mc = metaConfig();
  const body: MetricsResponse = {
    demo,
    campaigns: d.campaigns,
    rows: d.rows,
    syncs: s.syncs,
    config: {
      secretSet: secretSet(),
      metaReady: mc.ready,
      adAccountId: /^act_\d+$/.test(mc.account) ? mc.account : null,
    },
  };
  return NextResponse.json(body);
}

/** ล้างข้อมูลทั้งหมด (ต้องส่ง secret) */
export async function DELETE(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "secret ไม่ถูกต้อง" }, { status: 401 });
  await clearStore();
  return NextResponse.json({ ok: true });
}
