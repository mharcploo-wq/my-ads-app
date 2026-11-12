import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { isAgentId, isLocalRequest, runCreator, SuggestResult } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** หาความสนใจให้หน้าสร้างโฆษณา (หน้าเว็บแค่แสดงผล — server.py ตัดสินทั้งหมด)
 *  - mode "ai" (ปุ่ม ✨): {agent, ai_agent?, texts[], titles[], link_url?} — ai_agent = ยืม AI ของ agent อื่นเมื่อ AI ของตัวเองใช้ไม่ได้
 *  - mode "search" (พิมพ์คำค้นเอง ไม่ใช้ AI): {agent, words[], have[]} */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as {
    agent?: string; mode?: string; ai_agent?: string;
    texts?: unknown; titles?: unknown; link_url?: unknown; words?: unknown; have?: unknown;
  } | null;
  const agent = body?.agent ?? "";
  if (!body || !isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือกผู้สร้างไม่ถูกต้อง" }, { status: 400 });
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const search = body.mode === "search";
  const runner = !search && body.ai_agent ? body.ai_agent : agent;
  if (!isAgentId(runner)) return NextResponse.json({ ok: false, error: "เลือก AI ไม่ถูกต้อง" }, { status: 400 });
  const spec = search
    ? { words: list(body.words), have: list(body.have) }
    : { texts: list(body.texts), titles: list(body.titles), link_url: String(body.link_url ?? "").trim() };

  const tmp = path.join(os.tmpdir(), `ads-suggest-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = path.join(tmp, "spec.json");
    await fs.writeFile(file, JSON.stringify(spec), "utf8");
    const result = await runCreator<SuggestResult>(runner, [search ? "--search-json" : "--suggest-json", file], 120_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
