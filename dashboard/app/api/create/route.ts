import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { CreateResult, CreateSpec, isAgentId, isLocalRequest, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_IMAGE = 30 * 1024 * 1024;

/** สร้างโฆษณาครบชุด (PAUSED) จากฟอร์ม — multipart: agent, kind, name, daily_budget_thb, text, link_url, image_url, image */
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
  const kind = String(form.get("kind") ?? "");
  if (kind !== "MESSENGER" && kind !== "WEBSITE") return NextResponse.json({ ok: false, error: "เลือกชนิดโฆษณา" }, { status: 400 });

  const spec: CreateSpec = {
    kind,
    name: String(form.get("name") ?? "").trim(),
    daily_budget_thb: Number(form.get("daily_budget_thb") ?? 0),
    text: String(form.get("text") ?? "").trim(),
    link_url: String(form.get("link_url") ?? "").trim(),
    image_url: String(form.get("image_url") ?? "").trim(),
  };

  const tmp = path.join(os.tmpdir(), `ads-create-${randomUUID()}`);
  await fs.mkdir(tmp, { recursive: true });
  try {
    const file = form.get("image");
    if (file instanceof File && file.size > 0) {
      const ext = IMAGE_TYPES[file.type];
      if (!ext) return NextResponse.json({ ok: false, error: "รองรับเฉพาะไฟล์รูป JPG / PNG / WEBP / GIF" }, { status: 400 });
      if (file.size > MAX_IMAGE) return NextResponse.json({ ok: false, error: "รูปใหญ่เกิน 30MB" }, { status: 400 });
      spec.image_path = path.join(tmp, `image${ext}`);
      await fs.writeFile(spec.image_path, Buffer.from(await file.arrayBuffer()));
      spec.image_url = "";
    }
    const specFile = path.join(tmp, "spec.json");
    await fs.writeFile(specFile, JSON.stringify(spec), "utf8");
    const result = await runCreator<CreateResult>(agent, ["--create-json", specFile], 180_000);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
