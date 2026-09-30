import type { TrafficSample } from "@/entities/tunnel";
import { trafficWindow } from "@/entities/tunnel";

export function trafficPaths(
  samples: TrafficSample[],
  now: number,
  scale: number,
  direction: "rx" | "tx",
) {
  const cutoff = now - trafficWindow;
  const x = (time: number) =>
    Math.max(0, Math.min(1000, ((time - cutoff) / trafficWindow) * 1000));
  const y = (value: number) => 64 - Math.min(1, value / scale) * 56;
  const segments: TrafficSample[][] = [];
  for (const sample of samples) {
    if (sample.time <= cutoff || sample.start > now) continue;
    const segment = segments.at(-1);
    if (!segment || sample.start !== segment.at(-1)?.time)
      segments.push([sample]);
    else segment.push(sample);
  }
  let line = "",
    area = "";
  for (const segment of segments) {
    const first = segment[0];
    let path = `M ${x(first.start)} ${y(first[direction])}`;
    let previousX = x(first.start),
      previousY = y(first[direction]);
    for (const sample of segment) {
      const nextX = x(sample.time),
        nextY = y(sample[direction]);
      const middle = (previousX + nextX) / 2;
      path += ` C ${middle} ${previousY}, ${middle} ${nextY}, ${nextX} ${nextY}`;
      previousX = nextX;
      previousY = nextY;
    }
    line += path + " ";
    area += `${path} L ${previousX} 64 L ${x(first.start)} 64 Z `;
  }
  return { line: line.trim(), area: area.trim() };
}
