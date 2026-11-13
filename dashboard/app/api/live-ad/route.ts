import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { isAgentId, isLocalRequest, LiveAdsResult, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_IMAGE = 30 * 1024 * 1024;

/** เติมโฆษณาให้ชุด Live ที่สร้างไปแล้ว (หน้าเว็บแค่ส่งต่อ — server.py เช็คเจ้าของ/สิทธิ์ และสร้างเป็น PAUSED เสมอ)
 *  multipart: agent, mode (info | teaser | live), adset_id | campaign_id, live_id?, page_id? (ใช้เมื่อชุดยังไม่มีโฆษณา), text?, image? (ไฟล์รูป) */
export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ ok: false, error: "ใช้ได้จากเครื่องนี้เท่านั้น" }, { status: 403 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "ข้อมูลฟอร์มไม่ถูกต้อง" }, { status: 400 });
  }
  const agent = String(form.get("agent") ?? "");
  if (!isAgentId(agent)) return NextResponse.json({ ok: false, error: "เลือกผู้สร้างไม่ถูกต้อง" }, { status: 400 });
  const mode = String(form.get("mode") ?? "info");
  if (mode !== "info" && mode !== "teaser" && mode !== "live") return NextResponse.json({ ok: false, error: "ไม่รู้ว่าจะทำอะไร" }, { status: 400 });
  const id = (k: string) => (/^\d+$/.test(String(form.get(k) ?? "")) ? String(form.get(k)) : "");
  const spec: Record<string, string> = {
    mode, adset_id: id("adset_id"), campaign_id: id("campaign_id"), live_id: id("live_id"), page_id: id("page_id"),
    text: String(form.get("text") ?? "").trim().slice(0, 2000),
  };
  if (!spec.adset_id && !spec.campaign_id) return NextResponse.json({ ok: false, error: "ไม่รู้ว่าจะเติมโฆษณาให้ชุดไหน" }, { status: 400 });

  const tmp = path.join(os.tmpdir(), `ads-livead-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = form.get("image");
    if (mode === "teaser" && file instanceof File && file.size > 0) {
      const ext = IMAGE_TYPES[file.type];
      if (!ext) return NextResponse.json({ ok: false, error: "รองรับเฉพาะไฟล์รูป JPG / PNG / WEBP / GIF" }, { status: 400 });
      if (file.size > MAX_IMAGE) return NextResponse.json({ ok: false, error: "รูปใหญ่เกิน 30MB" }, { status: 400 });
      spec.image_path = path.join(tmp, `image${ext}`);
      await fs.writeFile(spec.image_path, Buffer.from(await file.arrayBuffer()));
    }
    const specFile = path.join(tmp, "spec.json");
    await fs.writeFile(specFile, JSON.stringify(spec), "utf8");
    const result = await runCreator<LiveAdsResult>(agent, ["--live-ad-json", specFile], 90_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
