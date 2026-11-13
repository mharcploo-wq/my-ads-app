import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { AdsetInterestsResult, isAgentId, isLocalRequest, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

/** ความสนใจของ Ad Set ที่สร้างไปแล้ว (หน้าเว็บแค่แสดงผล — server.py เช็คเจ้าของ/สถานะ PAUSED และตัดสินทั้งหมด)
 *  {agent, adset_id | campaign_id} = อ่าน · เพิ่ม save: true + interests [{id,name}] = บันทึก (แทนที่ชุดเดิม) */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as {
    agent?: string; adset_id?: unknown; campaign_id?: unknown; save?: unknown; interests?: unknown;
  } | null;
  const agent = body?.agent ?? "";
  if (!body || !isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือกผู้สร้างไม่ถูกต้อง" }, { status: 400 });
  const id = (v: unknown) => (/^\d+$/.test(String(v ?? "")) ? String(v) : "");
  const spec = {
    adset_id: id(body.adset_id),
    campaign_id: id(body.campaign_id),
    save: body.save === true,
    interests: Array.isArray(body.interests)
      ? body.interests.map((x) => ({ id: String((x as { id?: unknown })?.id ?? ""), name: String((x as { name?: unknown })?.name ?? "") }))
      : [],
  };
  if (!spec.adset_id && !spec.campaign_id) return NextResponse.json({ ok: false, error: "ไม่รู้ว่าจะแก้ Ad Set ไหน" }, { status: 400 });

  const tmp = path.join(os.tmpdir(), `ads-adset-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = path.join(tmp, "spec.json");
    await fs.writeFile(file, JSON.stringify(spec), "utf8");
    const result = await runCreator<AdsetInterestsResult>(agent, ["--adset-json", file], 60_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
