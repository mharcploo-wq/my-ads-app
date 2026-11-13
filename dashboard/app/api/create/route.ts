import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { CreateResult, CreateSpec, isAgentId, isLocalRequest, portfolioArgs, portfolioOf, runCreator } from "@/lib/creator";

export const dynamic = "force-dynamic";

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const VIDEO_TYPES: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v" };
const MAX_IMAGE = 30 * 1024 * 1024;

/** สร้างโฆษณาครบชุด (PAUSED) จากฟอร์ม — multipart: agent, kind, name, daily_budget_thb, text, link_url, image_url, image,
 *  portfolio (พอร์ตโฟลิโอ 1–5 · 1 = พอร์ตหลัก), page_id (เพจที่จะยิง), start_time, end_time, age_min, age_max, languages (ส่งซ้ำได้หลายค่า), interests (JSON [{id,name}])
 *  ชิ้นงานแบบไดนามิก: dynamic=1, images, videos, texts, titles (ส่งซ้ำได้หลายค่า) — ตรวจจำนวน/ขนาดจริงที่ server.py */
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
  if (kind !== "MESSENGER" && kind !== "WEBSITE" && kind !== "LIVE") return NextResponse.json({ ok: false, error: "เลือกชนิดโฆษณา" }, { status: 400 });

  const spec: CreateSpec = {
    kind,
    name: String(form.get("name") ?? "").trim(),
    daily_budget_thb: Number(form.get("daily_budget_thb") ?? 0),
    text: String(form.get("text") ?? "").trim(),
    link_url: String(form.get("link_url") ?? "").trim(),
    image_url: String(form.get("image_url") ?? "").trim(),
    start_time: String(form.get("start_time") ?? "").trim(),
    end_time: String(form.get("end_time") ?? "").trim(),
  };
  // เพจที่จะยิง — ส่งแค่เลข (server.py ตรวจว่า Token ลงโฆษณาในเพจนี้ได้) · ว่าง = เพจประจำ agent
  const pageId = String(form.get("page_id") ?? "");
  if (/^\d+$/.test(pageId)) spec.page_id = pageId;
  if (kind === "LIVE") {
    // Live: รูปชวนดู Live ได้ (ไฟล์/ลิงก์/ปกเพจ) · ไม่มีลิงก์/ไดนามิก (ปุ่มพาไปหน้ากิจกรรม Live)
    // เวลามาจาก Live ที่นัดไว้ (server.py อ่านจากเพจเอง ไม่เชื่อเวลาจากหน้าเว็บ)
    spec.live_id = /^\d+$/.test(String(form.get("live_id") ?? "")) ? String(form.get("live_id")) : "";
    spec.live_hours = Number(form.get("live_hours") ?? 0);
    spec.link_url = ""; spec.start_time = ""; spec.end_time = "";
  }
  const ageMin = String(form.get("age_min") ?? "").trim();
  if (ageMin) spec.age_min = Number(ageMin);
  const languages = form.getAll("languages").map((v) => String(v).trim()).filter(Boolean);
  if (languages.length) spec.languages = languages;
  const ageMax = String(form.get("age_max") ?? "").trim();
  if (ageMax) spec.age_max = Number(ageMax);
  const interestsRaw = String(form.get("interests") ?? "").trim();
  if (interestsRaw) {
    try {
      const list = JSON.parse(interestsRaw) as { id?: unknown; name?: unknown }[];
      spec.interests = (Array.isArray(list) ? list : []).map((x) => ({ id: String(x.id ?? ""), name: String(x.name ?? "") }));
    } catch {
      return NextResponse.json({ ok: false, error: "ข้อมูลความสนใจไม่ถูกต้อง" }, { status: 400 });
    }
  }
  const dynamic = form.get("dynamic") === "1" && kind !== "LIVE";
  if (dynamic) {
    spec.dynamic = true;
    spec.texts = form.getAll("texts").map((v) => String(v).trim()).filter(Boolean);
    spec.titles = form.getAll("titles").map((v) => String(v).trim()).filter(Boolean);
  }

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
    if (dynamic) {
      spec.image_paths = [];
      spec.video_paths = [];
      let i = 0;
      for (const f of form.getAll("images")) {
        if (!(f instanceof File) || f.size === 0) continue;
        const ext = IMAGE_TYPES[f.type];
        if (!ext) return NextResponse.json({ ok: false, error: `ไฟล์ ${f.name} ไม่ใช่รูป JPG / PNG / WEBP / GIF` }, { status: 400 });
        if (f.size > MAX_IMAGE) return NextResponse.json({ ok: false, error: `รูป ${f.name} ใหญ่เกิน 30MB` }, { status: 400 });
        const p = path.join(tmp, `image-${++i}${ext}`);
        await fs.writeFile(p, Buffer.from(await f.arrayBuffer()));
        spec.image_paths.push(p);
      }
      for (const f of form.getAll("videos")) {
        if (!(f instanceof File) || f.size === 0) continue;
        const ext = VIDEO_TYPES[f.type];
        if (!ext) return NextResponse.json({ ok: false, error: `ไฟล์ ${f.name} ไม่ใช่คลิป MP4 / MOV` }, { status: 400 });
        const p = path.join(tmp, `video-${++i}${ext}`);
        await fs.writeFile(p, Buffer.from(await f.arrayBuffer()));
        spec.video_paths.push(p);
      }
    }
    const specFile = path.join(tmp, "spec.json");
    await fs.writeFile(specFile, JSON.stringify(spec), "utf8");
    // คลิปต้องรอ Meta ประมวลผล — ให้เวลานานขึ้นเมื่อมีคลิป
    const timeout = spec.video_paths?.length ? 30 * 60_000 : 180_000;
    const portfolio = portfolioOf(form.get("portfolio"));
    const result = await runCreator<CreateResult>(agent, ["--create-json", specFile, ...portfolioArgs(portfolio)], timeout);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
