import { useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "@/entities/tunnel";
import { bytes } from "@/shared/lib/format";

const pointCount = 32;
const width = 1000;
const height = 64;
const floor = 59;
const ceiling = 9;

function pointY(value: number, peak: number) {
  return floor - (Math.log1p(value) / Math.log1p(peak)) * (floor - ceiling);
}

function linePath(values: number[]) {
  const peak = Math.max(1, ...values);
  const points = values.map((value, index) => ({
    x: (index / (values.length - 1)) * width,
    y: pointY(value, peak),
  }));
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const middle = (previous.x + point.x) / 2;
    return `${path} C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

export function ConnectionSparkline({ profile }: { profile: Profile }) {
  const [values, setValues] = useState(() => Array(pointCount).fill(0));
  const previous = useRef<{ updatedAt: number; total: number } | null>(null);
  const stats = profile.stats;

  useEffect(() => {
    if (!profile.active || !stats) {
      previous.current = null;
      setValues(Array(pointCount).fill(0));
      return;
    }

    const total = stats.peers.reduce((sum, peer) => sum + peer.rx + peer.tx, 0);
    const last = previous.current;
    previous.current = { updatedAt: stats.updatedAt, total };
    if (!last || stats.updatedAt <= last.updatedAt) return;

    const elapsed = (stats.updatedAt - last.updatedAt) / 1000;
    const rate = Math.max(0, total - last.total) / elapsed;
    setValues((current) => [...current.slice(1), rate]);
  }, [profile.active, stats]);

  const line = useMemo(() => linePath(values), [values]);
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;
  const currentRate = values.at(-1) || 0;
  const currentY = pointY(currentRate, Math.max(1, ...values));

  return (
    <div className="connection-sparkline" aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="connection-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#4f8d70" />
            <stop offset="0.55" stopColor="#82c69a" />
            <stop offset="1" stopColor="#c4f0cc" />
          </linearGradient>
          <linearGradient id="connection-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#90d7a5" stopOpacity="0.3" />
            <stop offset="1" stopColor="#90d7a5" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="connection-sparkline-area" d={area} />
        <path className="connection-sparkline-line" d={line} />
      </svg>
      <div
        className={
          "connection-speed-marker " + (currentY < 24 ? "below" : "above")
        }
        style={{ top: `${(currentY / height) * 100}%` }}
      >
        <span>{bytes(currentRate)}/s</span>
      </div>
    </div>
  );
}
