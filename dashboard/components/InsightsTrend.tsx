"use client";
import { useEffect, useRef, useState } from "react";
import { fmt, niceMax } from "@/lib/calc";

const M = { top: 22, right: 18, bottom: 26, left: 64 };

/** กราฟเส้นรายวันของหน้าวิเคราะห์โฆษณา — เส้นเดียว แกนเดียว · null = วันที่ไม่มีการแสดงผล (เว้นช่อง) */
export default function InsightsTrend({ dates, values, format, label, height = 240 }: {
  dates: string[]; values: (number | null)[]; format: (n: number) => string; label: string; height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const real = values.filter((v): v is number => v !== null);
  if (!dates.length || !real.length) return <div ref={box} className="empty">ยังไม่มีข้อมูลในช่วงนี้</div>;

  const iw = w - M.left - M.right, ih = height - M.top - M.bottom, last = dates.length - 1;
  const { max, ticks } = niceMax(Math.max(...real, 0));
  const x = (i: number) => M.left + (last === 0 ? iw / 2 : (i / last) * iw);
  const y = (v: number) => M.top + ih - (v / max) * ih;
  const xEvery = Math.max(1, Math.ceil(dates.length / Math.floor(iw / 70)));

  // เส้นขาดตรงวันที่ไม่มีค่า (CTR/CPM ของวันที่ไม่มีการแสดงผล)
  const segs: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === null) { if (cur.length) segs.push(cur.join(" ")); cur = []; return; }
    cur.push(`${x(i)},${y(v)}`);
  });
  if (cur.length) segs.push(cur.join(" "));

  const peak = values.reduce<number>((b, v, i) => (v !== null && (values[b] === null || v > (values[b] as number)) ? i : b), values.findIndex((v) => v !== null));
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(last, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * last))));
  };
  const hv = hover !== null ? values[hover] : null;

  return (
    <div ref={box} className="chart-box">
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={`กราฟ${label}รายวัน`}>
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {dates.map((d, i) => ((i % xEvery === 0 && last - i >= Math.ceil(xEvery / 2)) || i === last ? (
            <text key={d} x={x(i)} y={height - 6} textAnchor={i === last ? "end" : i === 0 ? "start" : "middle"}>{fmt.dateShort(d)}</text>
          ) : null))}
        </g>
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} stroke="var(--text-muted)" strokeDasharray="3 3" />}
        {segs.map((p, i) => (
          <polyline key={i} points={p} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {peak >= 0 && values[peak] !== null && (
          <>
            <circle cx={x(peak)} cy={y(values[peak] as number)} r={4} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={2} />
            <text x={x(peak)} y={y(values[peak] as number) - 10} textAnchor="middle" fill="var(--text-secondary)" fontSize={11.5}>
              สูงสุด {format(values[peak] as number)}
            </text>
          </>
        )}
        {hover !== null && hv !== null && <circle cx={x(hover)} cy={y(hv)} r={5} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={2} />}
        <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(x(hover) + 14, w - 190), top: M.top }}>
          <div className="t">{fmt.dateLong(dates[hover])}</div>
          <div className="r"><span>{label}</span><b className="num">{hv === null ? "ไม่มีการแสดงผล" : format(hv)}</b></div>
        </div>
      )}
    </div>
  );
}
