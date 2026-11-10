export const PREFIXES = ["CLD-", "MANUS-", "GPT-"] as const;
export type Prefix = (typeof PREFIXES)[number];

export const AGENTS: Record<Prefix, { label: string; key: string; color: string }> = {
  "CLD-": { label: "Claude", key: "claude", color: "var(--series-1)" },
  "MANUS-": { label: "Manus", key: "manus", color: "var(--series-2)" },
  "GPT-": { label: "ChatGPT", key: "chatgpt", color: "var(--series-3)" },
};

/** แคมเปญ 1 ตัว (ไม่มีตัวเลขผลลัพธ์) */
export interface Campaign {
  id: string;
  name: string;
  prefix: Prefix;
  status: string; // PAUSED / ACTIVE / ...
  objective: string | null;
  created_time: string | null;
}

/** ผลรายวันของแคมเปญ 1 ตัว (key = campaign_id|date) */
export interface DailyRow {
  date: string; // YYYY-MM-DD
  campaign_id: string;
  campaign_name: string;
  prefix: Prefix;
  spend: number; // บาท
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  results: number;
}

export interface SyncInfo {
  at: string;
  source: "mcp" | "meta";
  date_preset: string;
  campaigns: number;
  rows: number;
}

export interface Store {
  version: 1;
  campaigns: Record<string, Campaign>;
  rows: Record<string, DailyRow>;
  syncs: Partial<Record<Prefix, SyncInfo>>;
}

/** payload ที่ mcp-server/send_to_dashboard ส่งมา */
export interface IngestPayload {
  agent?: string;
  prefix?: string;
  date_preset?: string;
  sent_at?: string;
  campaigns?: Array<Partial<Campaign> & { id: string; name: string }>;
  rows?: Array<Partial<DailyRow> & { campaign_id: string; campaign_name: string; date: string }>;
  ping?: boolean;
}

export interface MetricsResponse {
  demo: boolean;
  campaigns: Campaign[];
  rows: DailyRow[];
  syncs: Partial<Record<Prefix, SyncInfo>>;
  config: { secretSet: boolean; metaReady: boolean; adAccountId: string | null };
}

export function prefixOf(name: string): Prefix | null {
  const up = (name || "").toUpperCase();
  return PREFIXES.find((p) => up.startsWith(p)) ?? null;
}
