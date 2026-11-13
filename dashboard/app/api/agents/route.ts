import { NextResponse } from "next/server";
import { AGENT_IDS, AgentId, AgentStatus, isAgentId, isLocalRequest, portfolioArgs, portfolioOf, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

const statusOf = (a: AgentId, portfolio: number) =>
  runCreator<AgentStatus>(a, ["--status", ...portfolioArgs(portfolio)], 60_000).catch((e: Error) => ({
    agent: a, prefix: "", ready: false, reason: e.message, checks: [], portfolio,
    max_daily_budget_thb: 0, max_campaigns_per_day: 0, campaigns_today: null, page_name: null, page_cover: null,
  }) satisfies AgentStatus);

/** สถานะของทั้ง 3 agent (พอร์ตหลัก + รายการพอร์ต) สำหรับหน้า "สร้างโฆษณา"
 *  ?agent=claude&portfolio=2 → สถานะของพอร์ตที่เลือกของ agent เดียว */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const one = q.get("agent");
  if (one !== null) {
    if (!isAgentId(one)) return NextResponse.json({ ok: false, error: "เลือกผู้สร้างไม่ถูกต้อง" }, { status: 400 });
    return NextResponse.json({ ok: true, agents: [await statusOf(one, portfolioOf(q.get("portfolio")))] });
  }
  const agents = await Promise.all(AGENT_IDS.map((a) => statusOf(a, 1)));
  return NextResponse.json({ ok: true, agents });
}
