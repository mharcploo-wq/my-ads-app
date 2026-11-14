import { NextResponse } from "next/server";
import { AgentStatus, isAgentId, isLocalRequest, runCreator } from "@/lib/creator";
import {
  AgentEnvInput, EDITABLE_KEYS, PORTFOLIO_KEYS, PortfolioInput, PortfolioKey,
  readAgentEnv, validate, validatePortfolios, writeAgentEnv,
} from "@/lib/agentEnv";

export const dynamic = "force-dynamic";

const forbidden = () => NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** GET ?agent=manus → ค่าในไฟล์ (โทเคน/secret ส่งแค่ว่าใส่แล้วหรือยัง + 4 ตัวท้าย) */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return forbidden();
  const agent = new URL(req.url).searchParams.get("agent") ?? "";
  if (!isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือก Agent ไม่ถูกต้อง" }, { status: 400 });
  return NextResponse.json({ ok: true, env: await readAgentEnv(agent) });
}

/** POST {agent, values, token?, secret?, aiKey?, portfolios?} → ตรวจ → บันทึกลงไฟล์ → ตรวจสิทธิ์ด้วย server.py --status
 *  portfolios: [{slot 2–5, token?, values{AD_ACCOUNT_ID,PAGE_ID,PIXEL_ID,VERIFIED_IDENTITY_ID}, remove?}] */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return forbidden();
  const body = (await req.json().catch(() => null)) as ({ agent?: string; portfolios?: unknown } & Partial<Omit<AgentEnvInput, "portfolios">>) | null;
  const agent = body?.agent ?? "";
  if (!body || !isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือก Agent ไม่ถูกต้อง" }, { status: 400 });

  const raw = (body.values ?? {}) as Record<string, unknown>;
  const portfolios: PortfolioInput[] | undefined = Array.isArray(body.portfolios)
    ? (body.portfolios as Record<string, unknown>[]).map((p) => {
        const v = (p?.values ?? {}) as Record<string, unknown>;
        return {
          slot: Number(p?.slot), token: str(p?.token), remove: p?.remove === true,
          values: Object.fromEntries(PORTFOLIO_KEYS.map((k) => [k, str(v[k])])) as Record<PortfolioKey, string>,
        };
      })
    : undefined;
  const input: AgentEnvInput = {
    values: Object.fromEntries(EDITABLE_KEYS.map((k) => [k, typeof raw[k] === "string" ? (raw[k] as string).trim() : String(raw[k] ?? "")])) as AgentEnvInput["values"],
    token: str(body.token), secret: str(body.secret), aiKey: str(body.aiKey), portfolios,
  };
  const before = await readAgentEnv(agent);
  const errors = {
    ...validate(agent, input),
    ...validatePortfolios(portfolios ?? [], new Set(before.portfolios.filter((p) => p.token.set).map((p) => p.slot))),
  };
  if (Object.keys(errors).length) return NextResponse.json({ ok: false, error: "มีช่องที่กรอกไม่ถูกต้อง", errors }, { status: 400 });

  await writeAgentEnv(agent, input);
  const status = await runCreator<AgentStatus>(agent, ["--status"], 60_000).catch((e: Error) => ({ error: e.message }));
  return NextResponse.json({ ok: true, env: await readAgentEnv(agent), status });
}
