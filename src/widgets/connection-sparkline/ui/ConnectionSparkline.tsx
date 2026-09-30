import { useEffect, useId, useRef, useState } from "react";
import { trafficHistory, type Profile } from "@/entities/tunnel";
import { bytes } from "@/shared/lib/format";
import { t } from "@/shared/lib/i18n";
import { trafficPaths } from "../model/paths";

export function ConnectionSparkline({ profile }: { profile: Profile }) {
  const [clock, setClock] = useState(Date.now);
  const lineRx = useRef<SVGPathElement>(null);
  const lineTx = useRef<SVGPathElement>(null);
  const areaRx = useRef<SVGPathElement>(null);
  const id = useId().replaceAll(":", "");
  const visible =
    (profile.active || profile.statusUnknown) && !profile.appRouting;

  useEffect(() => {
    if (!visible) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastTime: number | undefined;
    let appearedAt = 0;
    let displayScale = 0;
    let lastFrame = performance.now();
    const draw = () => {
      const now = Date.now();
      const { samples, scale, current } = trafficHistory.read(profile.id, now);
      const timestamp = performance.now();
      const latestTime = samples.at(-1)?.time;
      if (latestTime !== lastTime) {
        // Existing history is rendered immediately; only new measurements grow in.
        appearedAt = lastTime === undefined ? timestamp - 400 : timestamp;
        lastTime = latestTime;
      }
      const elapsed = Math.max(0, timestamp - lastFrame);
      displayScale =
        !displayScale || reducedMotion.matches
          ? scale
          : displayScale +
            (scale - displayScale) * (1 - Math.exp(-elapsed / 240));
      lastFrame = timestamp;
      const progress = reducedMotion.matches
        ? 1
        : Math.min(1, (timestamp - appearedAt) / 400);
      const rx = trafficPaths(
        samples,
        now,
        displayScale,
        "rx",
        progress,
        !!current,
      );
      const tx = trafficPaths(
        samples,
        now,
        displayScale,
        "tx",
        progress,
        !!current,
      );
      lineRx.current?.setAttribute("d", rx.line);
      lineTx.current?.setAttribute("d", tx.line);
      areaRx.current?.setAttribute("d", rx.area);
    };
    const tick = () => {
      if (document.hidden || reducedMotion.matches) return;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      if (document.hidden) return;
      lastFrame = performance.now();
      draw();
      setClock(Date.now());
      if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
      timer = setInterval(() => {
        setClock(Date.now());
        if (reducedMotion.matches) draw();
      }, 2500);
    };
    restart();
    document.addEventListener("visibilitychange", restart);
    reducedMotion.addEventListener("change", restart);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", restart);
      reducedMotion.removeEventListener("change", restart);
    };
  }, [profile.id, visible]);

  const { current } = trafficHistory.read(
    profile.id,
    Math.max(clock, Date.now()),
  );
  if (!visible) return null;
  const rate = (value: number) => `${bytes(value)}/${t("с")}`;
  return (
    <div
      className="connection-sparkline"
      role="group"
      aria-label={t("Трафик VPN за последнюю минуту")}
    >
      <svg viewBox="0 0 1000 64" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-rx`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          ref={areaRx}
          className="traffic-rx traffic-area"
          fill={`url(#${id}-rx)`}
        />
        <path ref={lineRx} className="traffic-rx traffic-line" />
        <path ref={lineTx} className="traffic-tx traffic-line" />
      </svg>
      {current && (
        <div className="traffic-chart-rates">
          <span className="traffic-rx" aria-label={t("Получено в секунду")}>
            ↓ {rate(current.rx)}
          </span>
          <span className="traffic-tx" aria-label={t("Отправлено в секунду")}>
            ↑ {rate(current.tx)}
          </span>
        </div>
      )}
    </div>
  );
}
