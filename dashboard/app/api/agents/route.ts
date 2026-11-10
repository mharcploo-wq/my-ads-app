import { NextResponse } from "next/server";
import { AGENT_IDS, AgentStatus, isLocalRequest, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** สถานะของทั้ง 3 agent สำหรับหน้า "สร้างโฆษณา" */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const agents = await Promise.all(
    AGENT_IDS.map((a) =>
      runCreator<AgentStatus>(a, ["--status"], 60_000).catch((e: Error) => ({
        agent: a, prefix: "", ready: false, reason: e.message, checks: [],
        max_daily_budget_thb: 0, max_campaigns_per_day: 0, campaigns_today: null, page_name: null, page_cover: null,
      }) satisfies AgentStatus),
    ),
  );
  return NextResponse.json({ ok: true, agents });
}
