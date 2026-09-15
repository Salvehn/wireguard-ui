import { useEffect, useRef, useState } from "react";
import type { Profile } from "@/entities/tunnel";
import { bytes } from "@/shared/lib/format";

const pointCount = 32;
const width = 1000;
const height = 64;
const floor = height;
const ceiling = 9;
const scaleBias = 100 * 1024 * 1024;
const sampleInterval = 2500;
const timeWindow = (pointCount - 1) * sampleInterval;

type Sample = { time: number; value: number };

function pointY(value: number) {
  const ratio =
    value > 0 ? Math.log1p(value) / Math.log1p(value + scaleBias) : 0;
  return floor - Math.min(1, ratio) * (floor - ceiling);
}

function paths(samples: Sample[], now: number) {
  const cutoff = now - timeWindow;
  const firstVisible = samples.findIndex((sample) => sample.time >= cutoff);
  const visible = samples.slice(Math.max(0, firstVisible - 1));
  const firstValue = visible[0]?.value || 0;
  const lastValue = visible.at(-1)?.value || 0;
  const timeline: Sample[] = [
    { time: cutoff, value: firstValue },
    ...visible.filter((sample) => sample.time > cutoff && sample.time < now),
    { time: now, value: lastValue },
  ];
  const points = timeline.map((sample) => ({
    x: ((sample.time - cutoff) / timeWindow) * width,
    y: pointY(sample.value),
  }));
  const line = points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const middle = (previous.x + point.x) / 2;
    return `${path} C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
  return {
    line,
    area: `${line} L ${width} ${height} L 0 ${height} Z`,
  };
}

export function ConnectionSparkline({ profile }: { profile: Profile }) {
  const samples = useRef<Sample[]>([]);
  const line = useRef<SVGPathElement>(null);
  const area = useRef<SVGPathElement>(null);
  const previous = useRef<{ updatedAt: number; total: number } | null>(null);
  const trafficVisible = useRef(false);
  const [currentRate, setCurrentRate] = useState(0);
  const [hasSample, setHasSample] = useState(false);
  const [hasTraffic, setHasTraffic] = useState(false);
  const stats = profile.stats;

  useEffect(() => {
    if (!profile.active || !stats) {
      previous.current = null;
      samples.current = [];
      trafficVisible.current = false;
      setCurrentRate(0);
      setHasSample(false);
      setHasTraffic(false);
      return;
    }

    // WireGuard exposes cumulative byte counters. Sampling their delta measures
    // throughput passively and never sends probe traffic through the tunnel.
    const total = stats.peers.reduce((sum, peer) => sum + peer.rx + peer.tx, 0);
    const last = previous.current;
    previous.current = { updatedAt: stats.updatedAt, total };
    if (!last || stats.updatedAt <= last.updatedAt) return;

    const elapsed = (stats.updatedAt - last.updatedAt) / 1000;
    const rate = Math.max(0, total - last.total) / elapsed;
    const lastRate = samples.current.at(-1)?.value || 0;
    const smoothed = rate === 0 ? 0 : lastRate * 0.55 + rate * 0.45;
    samples.current = [
      ...samples.current.filter(
        (sample) =>
          sample.time >= stats.updatedAt - timeWindow - sampleInterval,
      ),
      { time: stats.updatedAt, value: smoothed },
    ];
    setCurrentRate(smoothed);
    setHasSample(true);
  }, [profile.active, stats]);

  useEffect(() => {
    if (!profile.active) return;
    let frame = 0;
    const draw = () => {
      const now = Date.now();
      const chart = paths(samples.current, now);
      line.current?.setAttribute("d", chart.line);
      area.current?.setAttribute("d", chart.area);
      const visible = samples.current.some(
        (sample) => sample.time >= now - timeWindow && sample.value > 0,
      );
      if (visible !== trafficVisible.current) {
        trafficVisible.current = visible;
        setHasTraffic(visible);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [profile.active]);

  const currentY = pointY(currentRate);

  return (
    <div
      className={"connection-sparkline" + (profile.active ? " visible" : "")}
      aria-hidden="true"
    >
      <svg
        className={hasTraffic ? "has-traffic" : ""}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="connection-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#4f8d70" />
            <stop offset="0.55" stopColor="#82c69a" />
            <stop offset="1" stopColor="#c4f0cc" />
          </linearGradient>
          <linearGradient id="connection-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9cddad" stopOpacity="0.36" />
            <stop offset="0.55" stopColor="#6da37b" stopOpacity="0.16" />
            <stop offset="1" stopColor="#90d7a5" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path ref={area} className="connection-sparkline-area" />
        <path ref={line} className="connection-sparkline-line" />
      </svg>
      {hasSample && (
        <div
          className={
            "connection-speed-marker " +
            (currentY < 24 ? "below" : "above") +
            (currentRate > 0 ? "" : " idle")
          }
          style={{ top: `${(currentY / height) * 100}%` }}
        >
          <span>{bytes(currentRate)}/s</span>
        </div>
      )}
    </div>
  );
}
