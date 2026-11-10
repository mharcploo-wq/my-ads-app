import "server-only";
import { timingSafeEqual } from "crypto";

export function secretSet() {
  const s = (process.env.DASHBOARD_API_SECRET ?? "").trim();
  return s.length >= 12 && !s.includes("เปลี่ยน");
}

/** ตรวจ Authorization: Bearer <DASHBOARD_API_SECRET> */
export function authorized(req: Request): boolean {
  if (!secretSet()) return false;
  const want = Buffer.from(`Bearer ${process.env.DASHBOARD_API_SECRET!.trim()}`);
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}
