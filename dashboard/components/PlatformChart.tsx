"use client";
import { useEffect, useRef, useState } from "react";
import { fmt, niceMax } from "@/lib/calc";
import type { PlatformKey } from "@/lib/briefingTypes";

/** กราฟเส้นรายวันแยกแพลตฟอร์ม (หน้า Daily Briefing) — แกนเดียว · crosshair + tooltip · ป้ายชื่อปลายเส้นไม่ทับกัน
 *  ค่า null = วันนั้นไม่มีตัวเลข (เช่น ไม่มีผลลัพธ์ → ต้นทุนต่อผลลัพธ์หารไม่ได้) → เว้นช่วงเส้น ไม่วาดเป็น 0 */

export const PLATFORM_COLOR: Record<PlatformKey, string> = {
  facebook: "var(--series-1)",   // ผ่าน validate_palette (dark) คู่กับ 2 สีด้านล่าง
  instagram: "var(--series-2)",
  other: "var(--series-3)",
};

export interface ChartLine { key: PlatformKey; label: string; values: (number | null)[] }

const M = { top: 10, right: 78, bottom: 24, left: 56 };
const LABEL_GAP = 13;

export default function PlatformChart({ days, lines, unit, height = 200 }: {
  days: string[]; lines: ChartLine[]; unit: "baht" | "count"; height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  if (!lines.some((l) => l.values.some((v) => v !== null)))
    return <div ref={box} className="empty">ไม่มีตัวเลขให้วาดใน 8 วันนี้{unit === "baht" ? " (ไม่มีผลลัพธ์ จึงหารต้นทุนไม่ได้)" : ""}</div>;

  const show = (v: number | null) => (v === null ? "—" : unit === "baht" ? fmt.baht(v) : fmt.int(v));
  const all = lines.flatMap((l) => l.values).filter((v): v is number => v !== null);
  const { max, ticks } = niceMax(unit === "count" ? Math.max(3, ...all) : Math.max(0, ...all));
  const tickVals = unit === "count" ? ticks.filter((t) => Number.isInteger(t)) : ticks;
  const iw = w - M.left - M.right, ih = height - M.top - M.bottom;
  const x = (i: number) => M.left + (days.length > 1 ? (i * iw) / (days.length - 1) : iw / 2);
  const y = (v: number) => M.top + ih * (1 - v / (max || 1));

  // ป้ายปลายเส้น: ค่าสุดท้ายที่มีของแต่ละเส้น → ดันให้ห่างกันอย่างน้อย LABEL_GAP แล้วเลื่อนทั้งชุดขึ้นถ้าล้นขอบล่าง
  const ends = lines.map((l) => {
    const i = l.values.map((v, k) => (v === null ? -1 : k)).filter((k) => k >= 0).pop();
    return i === undefined ? null : { key: l.key, label: l.label, i, y: y(l.values[i] as number) };
  }).filter((e): e is NonNullable<typeof e> => e !== null).sort((a, b) => a.y - b.y);
  const labelY = ends.map((e) => e.y);
  for (let k = 1; k < labelY.length; k++) if (labelY[k] - labelY[k - 1] < LABEL_GAP) labelY[k] = labelY[k - 1] + LABEL_GAP;
  const over = labelY.length ? Math.max(0, labelY[labelY.length - 1] - (M.top + ih)) : 0;

  const path = (vals: (number | null)[]) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - M.left) / iw) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  return (
    <div ref={box} className="pchart">
      <div className="legend">
        {lines.map((l) => <span key={l.key}><i className="line" style={{ background: PLATFORM_COLOR[l.key] }} />{l.label}</span>)}
      </div>
      <svg width={w} height={height} role="img" aria-label="กราฟรายวันแยกแพลตฟอร์ม">
        {tickVals.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={M.left - 6} y={y(t) + 4} fill="var(--text-muted)" fontSize="10.5" textAnchor="end">{unit === "baht" ? fmt.baht(t) : fmt.int(t)}</text>
          </g>
        ))}
        {days.map((d, i) => (i % 2 === 1 || i === days.length - 1) && (
          <text key={d} x={x(i)} y={height - 6} fill="var(--text-muted)" fontSize="10.5" textAnchor="middle">
            {i === days.length - 1 ? "เมื่อวาน" : fmt.dateShort(d)}
          </text>
        ))}
        {lines.map((l) => <path key={l.key} d={path(l.values)} fill="none" stroke={PLATFORM_COLOR[l.key]} strokeWidth={2} strokeLinejoin="round" />)}
        {/* จุดเดี่ยว (วันก่อน-หลังไม่มีตัวเลข) วาดเป็นเส้นไม่ได้ → แสดงเป็นจุด */}
        {lines.flatMap((l) => l.values.map((v, i) => v !== null && (l.values[i - 1] ?? null) === null && (l.values[i + 1] ?? null) === null
          ? <circle key={`${l.key}-${i}`} cx={x(i)} cy={y(v)} r={3} fill={PLATFORM_COLOR[l.key]} /> : null))}
        {ends.map((e, k) => (
          <g key={e.key}>
            <circle cx={x(e.i)} cy={e.y} r={4} fill={PLATFORM_COLOR[e.key]} stroke="var(--surface-1)" strokeWidth={2} />
            <text x={M.left + iw + 8} y={labelY[k] - over + 4} fill="var(--text-secondary)" fontSize="11">{e.label}</text>
          </g>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} stroke="var(--text-muted)" strokeDasharray="3 3" />}
        <rect x={M.left} y={0} width={iw} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className="ptip" style={{ left: Math.min(x(hover) + 12, w - 170) }}>
          <b>{fmt.dateShort(days[hover])}{hover === days.length - 1 ? " (เมื่อวาน)" : ""}</b>
          {lines.map((l) => (
            <div key={l.key}><span className="swatch" style={{ background: PLATFORM_COLOR[l.key] }} />{l.label} {show(l.values[hover])}</div>
          ))}
        </div>
      )}
    </div>
  );
}
