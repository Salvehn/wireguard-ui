import { useEffect, useId, useState } from "react";
import { trafficHistory, type Profile } from "@/entities/tunnel";
import { bytes } from "@/shared/lib/format";
import { t } from "@/shared/lib/i18n";
import { trafficPaths } from "../model/paths";

export function ConnectionSparkline({ profile }: { profile: Profile }) {
  const [clock, setClock] = useState(Date.now);
  const id = useId().replaceAll(":", "");
  // Age history and detect stale readings without a permanent animation-frame loop.
  useEffect(() => {
    if (!profile.active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      clearInterval(timer);
      if (document.hidden) return;
      setClock(Date.now());
      timer = setInterval(() => setClock(Date.now()), 2500);
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [profile.active]);
  const now = Math.max(clock, Date.now());
  const { samples, current, scale } = trafficHistory.read(profile.id, now);
  const rx = trafficPaths(samples, now, scale, "rx");
  const tx = trafficPaths(samples, now, scale, "tx");
  if (!profile.active && !profile.statusUnknown) return null;
  const rate = (value: number) => `${bytes(value)}/${t("с")}`;
  return (
    <div
      className="connection-sparkline"
      role="group"
      aria-label={t("Трафик VPN за последнюю минуту")}
    >
      <div className="traffic-chart-heading">
        <span>{t("ТРАФИК · 60 С")}</span>
        <div className="traffic-chart-rates">
          <span className="traffic-rx" aria-label={t("Получено в секунду")}>
            ↓ {current ? rate(current.rx) : "—"}
          </span>
          <span className="traffic-tx" aria-label={t("Отправлено в секунду")}>
            ↑ {current ? rate(current.tx) : "—"}
          </span>
        </div>
      </div>
      <div className="traffic-chart-plot">
        <svg
          viewBox="0 0 1000 72"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={`${id}-rx`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0.015" />
            </linearGradient>
          </defs>
          <path
            className="traffic-grid"
            d="M 0 8 H 1000 M 0 36 H 1000 M 0 64 H 1000"
          />
          <path
            className="traffic-rx traffic-area"
            fill={`url(#${id}-rx)`}
            d={rx.area}
          />
          <path className="traffic-rx traffic-line" d={rx.line} />
          <path className="traffic-tx traffic-line" d={tx.line} />
        </svg>
        <span className="traffic-chart-scale">{rate(scale)}</span>
        {!current && (
          <span className="traffic-chart-message">
            {t(
              profile.appRouting
                ? "Статистика трафика недоступна."
                : "Ожидаем данные о трафике…",
            )}
          </span>
        )}
      </div>
      <div className="traffic-chart-axis">
        <span>{t("−60 с")}</span>
        <span>{t("Сейчас")}</span>
      </div>
    </div>
  );
}
