import { Campaign, DailyRow, Prefix, PREFIXES } from "./types";

export interface Totals {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  results: number;
  ctr: number; // %
  cpr: number | null; // บาท/ผลลัพธ์
  cpc: number | null;
  cpm: number | null;
}

export function totals(rows: DailyRow[]): Totals {
  const t = rows.reduce(
    (a, r) => {
      a.spend += r.spend; a.impressions += r.impressions; a.reach += r.reach;
      a.clicks += r.clicks; a.link_clicks += r.link_clicks; a.results += r.results;
      return a;
    },
    { spend: 0, impressions: 0, reach: 0, clicks: 0, link_clicks: 0, results: 0 },
  );
  return {
    ...t,
    ctr: t.impressions ? (t.link_clicks / t.impressions) * 100 : 0,
    cpr: t.results ? t.spend / t.results : null,
    cpc: t.link_clicks ? t.spend / t.link_clicks : null,
    cpm: t.impressions ? (t.spend / t.impressions) * 1000 : null,
  };
}

/** วันที่ทั้งหมดในช่วง N วันล่าสุด (นับจากวันล่าสุดที่มีข้อมูล) */
export function dateWindow(rows: DailyRow[], days: number): { dates: string[]; prev: string[] } {
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  if (!last) return { dates: [], prev: [] };
  const first = rows.reduce((m, r) => (r.date < m ? r.date : m), last);
  const end = new Date(last + "T00:00:00Z").getTime();
  // ไม่วาดวันก่อนมีข้อมูลวันแรกเป็น 0 (จะดูเหมือนใช้เงิน 0 บาท)
  const span = Math.round((end - new Date(first + "T00:00:00Z").getTime()) / 86400e3) + 1;
  const n = Math.min(days, span);
  const mk = (offset: number) =>
    Array.from({ length: n }, (_, i) => new Date(end - (offset + n - 1 - i) * 86400e3).toISOString().slice(0, 10));
  return { dates: mk(0), prev: mk(n) };
}

export function seriesByAgent(rows: DailyRow[], dates: string[], metric: keyof Pick<DailyRow, "spend" | "results" | "link_clicks" | "impressions">) {
  const idx = new Map(dates.map((d, i) => [d, i]));
  const out = Object.fromEntries(PREFIXES.map((p) => [p, new Array(dates.length).fill(0)])) as Record<Prefix, number[]>;
  for (const r of rows) {
    const i = idx.get(r.date);
    if (i !== undefined) out[r.prefix][i] += r[metric];
  }
  return out;
}

export interface CampaignStat extends Campaign, Totals {}

export function campaignStats(campaigns: Campaign[], rows: DailyRow[]): CampaignStat[] {
  const by = new Map<string, DailyRow[]>();
  for (const r of rows) (by.get(r.campaign_id) ?? by.set(r.campaign_id, []).get(r.campaign_id)!).push(r);
  return campaigns.map((c) => ({ ...c, ...totals(by.get(c.id) ?? []) }));
}

const nf0 = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt = {
  int: (n: number) => nf0.format(n),
  baht: (n: number | null) => (n === null ? "—" : `฿${n >= 100 ? nf0.format(n) : nf2.format(n)}`),
  pct: (n: number) => `${nf2.format(n)}%`,
  compact: (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : nf0.format(n),
  dateShort: (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: "UTC" }),
  dateLong: (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
  ago: (iso: string) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "เมื่อสักครู่";
    if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
    if (s < 86400) return `${Math.floor(s / 3600)} ชม.ที่แล้ว`;
    return `${Math.floor(s / 86400)} วันที่แล้ว`;
  },
};

/** ปัดสเกลแกน y ให้เป็นเลขกลม */
export function niceMax(v: number): { max: number; ticks: number[] } {
  if (v <= 0) return { max: 1, ticks: [0, 1] };
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.map((s) => (s * exp) / 2).find((s) => v / s <= 5) ?? exp;
  const max = Math.ceil(v / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return { max, ticks };
}
