import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { isAgentId, isLocalRequest, ReachResult, runCreator, SuggestResult } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** หาความสนใจให้หน้าสร้างโฆษณา (หน้าเว็บแค่แสดงผล — server.py ตัดสินทั้งหมด)
 *  - mode "ai" (ปุ่ม ✨): {agent, ai_agent?, texts[], titles[], link_url?} — ai_agent = ยืม AI ของ agent อื่นเมื่อ AI ของตัวเองใช้ไม่ได้
 *  - mode "search" (ช่องพิมพ์คำค้น): {agent, ai_agent?, text, have[], texts[], titles[], link_url?}
 *    คำสั้นคั่นด้วย , = ค้นตรงใน Meta · ประโยคบอกความต้องการ = server.py ให้ AI อ่านก่อน (ตัดสินที่ server.py)
 *  - mode "reach" (แถบรวมคนในไทย): {agent, ids[]} — ไม่ใช้ AI
 *  - mode "poll" (Manus กำลังคิด): {agent, task_id, kind, have[]} — ถามผล 1 ครั้ง · ยังไม่เสร็จ = result.pending
 *  - mode "stop" (ปุ่มยกเลิกระหว่างรอ Manus): {agent, task_id} */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as {
    agent?: string; mode?: string; ai_agent?: string; text?: unknown;
    texts?: unknown; titles?: unknown; link_url?: unknown; words?: unknown; have?: unknown; ids?: unknown;
    task_id?: unknown; kind?: unknown;
  } | null;
  const agent = body?.agent ?? "";
  if (!body || !isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือกผู้สร้างไม่ถูกต้อง" }, { status: 400 });
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  if (body.mode === "poll" || body.mode === "stop") {
    const taskId = String(body.task_id ?? "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(taskId)) return NextResponse.json({ ok: false, error: "รหัสงาน Manus ไม่ถูกต้อง" }, { status: 400 });
    try {
      if (body.mode === "stop") return NextResponse.json({ ok: true, result: await runCreator<SuggestResult>(agent, ["--ai-stop", taskId], 60_000) });
      return NextResponse.json({ ok: true, result: await withSpec({ task_id: taskId, kind: body.kind === "brief" ? "brief" : "suggest", have: list(body.have) },
        (file) => runCreator<SuggestResult>(agent, ["--ai-poll-json", file], 120_000)) });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }
  const search = body.mode === "search";
  const reach = body.mode === "reach";
  const runner = body.ai_agent && !reach ? body.ai_agent : agent;
  if (!isAgentId(runner)) return NextResponse.json({ ok: false, error: "เลือก AI ไม่ถูกต้อง" }, { status: 400 });
  const copy = { texts: list(body.texts), titles: list(body.titles), link_url: String(body.link_url ?? "").trim() };
  const spec = reach
    ? { ids: list(body.ids) }
    : search
      ? { text: String(body.text ?? "").slice(0, 500), words: list(body.words), have: list(body.have), ...copy }
      : copy;
  const flag = reach ? "--reach-json" : search ? "--search-json" : "--suggest-json";

  try {
    const result = await withSpec(spec, (file) => runCreator<SuggestResult | ReachResult>(runner, [flag, file], 120_000));
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** เขียน spec ลงไฟล์ชั่วคราวให้ server.py อ่าน แล้วลบทิ้งเสมอ */
async function withSpec<T>(spec: unknown, run: (file: string) => Promise<T>): Promise<T> {
  const tmp = path.join(os.tmpdir(), `ads-suggest-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = path.join(tmp, "spec.json");
    await fs.writeFile(file, JSON.stringify(spec), "utf8");
    return await run(file);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
