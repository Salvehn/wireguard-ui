import type { TrafficSample } from "@/entities/tunnel";
import { trafficWindow } from "@/entities/tunnel";

export function trafficPaths(
  samples: TrafficSample[],
  now: number,
  scale: number,
  direction: "rx" | "tx",
  newestProgress = 1,
  live = false,
) {
  const cutoff = now - trafficWindow;
  const x = (time: number) =>
    Math.max(0, Math.min(1000, ((time - cutoff) / trafficWindow) * 1000));
  const y = (value: number) => 64 - Math.min(1, value / scale) * 56;
  const segments: TrafficSample[][] = [];
  for (const [index, original] of samples.entries()) {
    const preceding = samples[index - 1];
    const continuous = preceding?.time === original.start;
    const sample =
      index === samples.length - 1 && newestProgress < 1
        ? {
            ...original,
            rx: continuous
              ? preceding.rx +
                (original.rx - preceding.rx) * Math.max(0, newestProgress)
              : original.rx,
            tx: continuous
              ? preceding.tx +
                (original.tx - preceding.tx) * Math.max(0, newestProgress)
              : original.tx,
            time:
              original.start +
              (original.time - original.start) * Math.max(0, newestProgress),
          }
        : original;
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
    // Hold the latest measured rate at the live edge without altering history.
    // Older segments still stop at their actual timestamps, preserving gaps.
    if (live && segment === segments.at(-1)) {
      path += ` H 1000`;
      previousX = 1000;
    }
    line += path + " ";
    area += `${path} L ${previousX} 64 L ${x(first.start)} 64 Z `;
  }
  return { line: line.trim(), area: area.trim() };
}
