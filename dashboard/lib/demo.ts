import { Campaign, DailyRow, Prefix } from "./types";

/** ข้อมูลตัวอย่าง (สุ่มแบบคงที่) — ใช้เฉพาะตอนยังไม่มีข้อมูลจริง และหน้าจอติดป้าย "ข้อมูลตัวอย่าง" เสมอ */
export function demoData(days = 30): { campaigns: Campaign[]; rows: DailyRow[] } {
  let seed = 20261110;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const plan: { p: Prefix; names: string[]; ctr: number; cvr: number; cpm: number }[] = [
    { p: "CLD-", names: ["คอร์สออนไลน์-Traffic", "ลีดสัมมนา-Leads", "รีทาร์เก็ต-Sales"], ctr: 0.021, cvr: 0.06, cpm: 85 },
    { p: "MANUS-", names: ["ทดสอบครีเอทีฟ-A", "ทดสอบครีเอทีฟ-B"], ctr: 0.016, cvr: 0.045, cpm: 78 },
    { p: "GPT-", names: ["คอนเทนต์รีวิว-Traffic", "แคปชันใหม่-Leads", "โปรเดือนนี้-Sales"], ctr: 0.019, cvr: 0.052, cpm: 92 },
  ];
  const today = new Date(Date.now() + 7 * 3600e3); // เวลาไทย
  const campaigns: Campaign[] = [];
  const rows: DailyRow[] = [];
  plan.forEach((a, ai) =>
    a.names.forEach((n, ni) => {
      const id = `demo_${ai}${ni}`;
      const name = `${a.p}${n}`;
      const status = ni === 0 ? "ACTIVE" : "PAUSED";
      const objective = n.includes("Leads") ? "OUTCOME_LEADS" : n.includes("Sales") ? "OUTCOME_SALES" : "OUTCOME_TRAFFIC";
      campaigns.push({ id, name, prefix: a.p, status, objective, created_time: null });
      const budget = 250 + Math.round(rnd() * 500);
      for (let d = days - 1; d >= 0; d--) {
        if (status === "PAUSED" && d < 4) continue; // หยุดไปช่วงหลัง
        const date = new Date(today.getTime() - d * 86400e3).toISOString().slice(0, 10);
        const spend = Math.round(budget * (0.75 + rnd() * 0.4) * (1 + (days - d) / (days * 3)));
        const impressions = Math.round((spend / a.cpm) * 1000 * (0.85 + rnd() * 0.3));
        const clicks = Math.round(impressions * a.ctr * (0.8 + rnd() * 0.4));
        const link = Math.round(clicks * 0.8);
        rows.push({
          date, campaign_id: id, campaign_name: name, prefix: a.p, spend, impressions,
          reach: Math.round(impressions * 0.72), clicks, link_clicks: link,
          results: Math.round(link * a.cvr * (0.6 + rnd() * 0.8)),
        });
      }
    }),
  );
  return { campaigns, rows };
}
