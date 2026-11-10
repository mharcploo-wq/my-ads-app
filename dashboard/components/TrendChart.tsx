"use client";
import { useEffect, useRef, useState } from "react";
import { fmt, niceMax } from "@/lib/calc";
import { AGENTS, Prefix } from "@/lib/types";

interface Props {
  dates: string[];
  series: Partial<Record<Prefix, number[]>>;
  format: (n: number) => string;
  height?: number;
}

const M = { top: 12, right: 74, bottom: 26, left: 52 };

/** กราฟเส้นรายวัน 1 แกน — crosshair + tooltip + ป้ายชื่อปลายเส้น */
export default function TrendChart({ dates, series, format, height = 280 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const keys = Object.keys(series) as Prefix[];
  if (!dates.length || !keys.length) return <div ref={box} className="empty">ยังไม่มีข้อมูลในช่วงนี้</div>;

  const iw = w - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const all = keys.flatMap((k) => series[k]!);
  const { max, ticks } = niceMax(Math.max(...all, 0));
  const x = (i: number) => M.left + (dates.length === 1 ? iw / 2 : (i / (dates.length - 1)) * iw);
  const y = (v: number) => M.top + ih - (v / max) * ih;

  const xEvery = Math.max(1, Math.ceil(dates.length / Math.floor(iw / 70)));

  // ป้ายปลายเส้น: เรียงตามค่า y แล้วดันให้ห่างกันอย่างน้อย 15px
  const last = dates.length - 1;
  const labels = keys
    .map((k) => ({ k, y: y(series[k]![last]) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 15);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * iw;
    setHover(Math.min(last, Math.max(0, Math.round((px / iw) * last))));
  };

  const tipLeft = hover !== null ? Math.min(x(hover) + 14, w - 190) : 0;

  return (
    <div ref={box} className="chart-box">
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label="กราฟแนวโน้มรายวันแยกตาม Agent">
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmt.compact(t)}</text>
            </g>
          ))}
          {dates.map((d, i) =>
            i % xEvery === 0 || i === last ? (
              <text key={d} x={x(i)} y={height - 6} textAnchor={i === last ? "end" : i === 0 ? "start" : "middle"}>
                {fmt.dateShort(d)}
              </text>
            ) : null,
          )}
        </g>

        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} stroke="var(--text-muted)" strokeDasharray="3 3" />
        )}

        {keys.map((k) => {
          const pts = series[k]!.map((v, i) => `${x(i)},${y(v)}`).join(" ");
          return (
            <polyline key={k} points={pts} fill="none" stroke={AGENTS[k].color} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" />
          );
        })}

        {/* จุดปลายเส้น + ป้ายชื่อ */}
        {keys.map((k) => (
          <circle key={k} cx={x(last)} cy={y(series[k]![last])} r={4} fill={AGENTS[k].color}
            stroke="var(--surface-1)" strokeWidth={2} />
        ))}
        {keys.length <= 4 &&
          labels.map((l) => (
            <text key={l.k} x={x(last) + 10} y={l.y} dy="0.32em" fill="var(--text-secondary)" fontSize={12}>
              {AGENTS[l.k].label}
            </text>
          ))}

        {hover !== null &&
          keys.map((k) => (
            <circle key={k} cx={x(hover)} cy={y(series[k]![hover])} r={5} fill={AGENTS[k].color}
              stroke="var(--surface-1)" strokeWidth={2} />
          ))}

        <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>

      {hover !== null && (
        <div className="tooltip" style={{ left: tipLeft, top: M.top }}>
          <div className="t">{fmt.dateLong(dates[hover])}</div>
          {[...keys]
            .sort((a, b) => series[b]![hover] - series[a]![hover])
            .map((k) => (
              <div className="r" key={k}>
                <span><i className="swatch" style={{ background: AGENTS[k].color }} />{AGENTS[k].label}</span>
                <b className="num">{format(series[k]![hover])}</b>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
