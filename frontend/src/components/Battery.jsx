import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Battery as BatteryIcon,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
} from "lucide-react";
import { batteryLevel, fmtDateTime, fmtRelative } from "../format.js";

const LEVEL_LABEL = { good: "Bon", warning: "Moyen", critical: "Faible", unknown: "Inconnu" };

export function batteryIcon(battery) {
  if (!battery) return BatteryIcon;
  if (battery.charging) return BatteryCharging;
  const p = battery.percent;
  if (p >= 80) return BatteryFull;
  if (p >= 40) return BatteryMedium;
  if (p >= 20) return BatteryLow;
  return BatteryWarning;
}

export function BatteryPill({ battery, onClick }) {
  const Icon = batteryIcon(battery);
  const level = batteryLevel(battery?.percent);
  return (
    <button
      className={`battery-pill ${level}`}
      onClick={onClick}
      title={battery ? `Batterie relevée ${fmtRelative(battery.ts)}` : "Batterie inconnue"}
    >
      <Icon size={18} />
      <span>{battery ? `${battery.percent} %` : "— %"}</span>
    </button>
  );
}

export function BatteryMeter({ battery }) {
  const level = batteryLevel(battery?.percent);
  const Icon = batteryIcon(battery);
  return (
    <div className="meter-wrap">
      <div className={`meter ${level}`} aria-hidden="true">
        <div className="meter-fill" style={{ width: `${battery?.percent ?? 0}%` }} />
      </div>
      <div className={`status-line ${level}`}>
        <Icon size={15} />
        <span>
          {LEVEL_LABEL[level]}
          {battery?.charging ? " · en charge" : ""}
        </span>
      </div>
    </div>
  );
}

const H = 220;
const PAD = { top: 12, right: 16, bottom: 26, left: 36 };

/** Battery level over time, with each series' pause threshold as a reference line. */
export function BatteryChart({ history, thresholds, hours }) {
  const [hover, setHover] = useState(null);
  const [W, setW] = useState(720);
  const svgRef = useRef(null);
  const wrapRef = useRef(null);

  // Draw at the real pixel width so text and strokes keep their size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const end = Date.now();
    const start = end - hours * 3600 * 1000;
    const pts = history
      .map((h) => ({ t: new Date(h.ts).getTime(), v: h.percent, ts: h.ts, charging: h.charging }))
      .filter((p) => p.t >= start);
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const x = (t) => PAD.left + ((t - start) / (end - start)) * iw;
    const y = (v) => PAD.top + (1 - v / 100) * ih;
    const ticks = [];
    const stepH = (hours <= 24 ? 6 : hours <= 72 ? 12 : 24) * (W < 520 ? 2 : 1);
    const first = new Date(start);
    first.setMinutes(0, 0, 0);
    first.setHours(Math.ceil(first.getHours() / stepH) * stepH);
    for (let t = first.getTime(); t <= end; t += stepH * 3600 * 1000) ticks.push(t);
    return { pts, x, y, ticks, start, end, iw, ih };
  }, [history, hours, W]);

  const { pts, x, y, ticks } = geom;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = pts.length
    ? `${line}L${x(pts[pts.length - 1].t).toFixed(1)},${y(0)}L${x(pts[0].t).toFixed(1)},${y(0)}Z`
    : "";

  const onMove = (e) => {
    if (!pts.length) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    setHover(best);
  };

  const tickLabel = (t) => {
    const d = new Date(t);
    return d.getHours() === 0
      ? d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })
      : `${d.getHours()}h`;
  };

  return (
    <div className="chart" ref={wrapRef}>
      {!pts.length ? (
        <div className="chart-empty">Pas encore de relevé de batterie sur cette période.</div>
      ) : (
      <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Niveau de batterie sur ${hours} heures`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="axis" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} className="axis" x={x(t)} y={H - 6} textAnchor="middle">
            {tickLabel(t)}
          </text>
        ))}
        {thresholds.map((th) => (
          <g key={th.id}>
            <line className="threshold" x1={PAD.left} x2={W - PAD.right} y1={y(th.value)} y2={y(th.value)} />
            <text className="threshold-label" x={W - PAD.right} y={y(th.value) - 5} textAnchor="end">
              Pause « {th.name} » sous {th.value} %
            </text>
          </g>
        ))}
        <path className="area" d={area} />
        <path className="line" d={line} />
        {pts.length === 1 && <circle className="dot" cx={x(pts[0].t)} cy={y(pts[0].v)} r={4} />}
        {hover && (
          <g>
            <line className="crosshair" x1={x(hover.t)} x2={x(hover.t)} y1={PAD.top} y2={H - PAD.bottom} />
            <circle className="dot" cx={x(hover.t)} cy={y(hover.v)} r={5} />
          </g>
        )}
      </svg>
      {hover && (
        <div
          className="tooltip"
          style={{
            left: `${(x(hover.t) / W) * 100}%`,
            top: `${(y(hover.v) / H) * 100}%`,
          }}
        >
          <strong>{hover.v} %</strong>
          <span>{fmtDateTime(hover.ts)}</span>
          {hover.charging && <span>En charge</span>}
        </div>
      )}
      </>
      )}
    </div>
  );
}
