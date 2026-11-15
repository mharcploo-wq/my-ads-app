export type AgentId = "claude" | "manus" | "chatgpt";

/** แคมเปญที่สร้างไปแล้วจากชุดความสนใจของ agent หนึ่งตัว */
export interface Made {
  campaign_id: string;
  campaign_name: string;
  adset_id?: string | null;
  ads?: number | null;            // จำนวนโฆษณาที่ขอสร้าง (การมีส่วนร่วม = คลิปละ 1)
  url?: string | null;            // ลิงก์ Ads Manager
  interest_ids: string[];         // ความสนใจตอนสร้าง — ไว้เทียบว่าชุดเปลี่ยนไปหลังสร้างไหม
  at: number;                     // เวลาสร้าง (ms)
}

/** ลายเซ็นชุดความสนใจ (ไม่สนลำดับ) */
export const interestSig = (ids: string[]) => [...ids].sort().join(",");
