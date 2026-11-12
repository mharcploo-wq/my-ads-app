import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { isAgentId, isLocalRequest, runCreator, SuggestResult } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ปุ่ม ✨ ให้ AI คิดกลุ่มเป้าหมาย — JSON {agent, texts[], titles[], link_url?}
 *  server.py ถาม AI ของ agent นั้น แล้วค้นคลังความสนใจของ Meta (หน้าเว็บแค่แสดงผล) */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { agent?: string; texts?: unknown; titles?: unknown; link_url?: unknown } | null;
  const agent = body?.agent ?? "";
  if (!body || !isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือกผู้สร้างไม่ถูกต้อง" }, { status: 400 });
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const spec = { texts: list(body.texts), titles: list(body.titles), link_url: String(body.link_url ?? "").trim() };

  const tmp = path.join(os.tmpdir(), `ads-suggest-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = path.join(tmp, "spec.json");
    await fs.writeFile(file, JSON.stringify(spec), "utf8");
    const result = await runCreator<SuggestResult>(agent, ["--suggest-json", file], 120_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
