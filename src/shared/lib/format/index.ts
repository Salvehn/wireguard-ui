import { t, getLanguage } from "@/shared/lib/i18n";
export function bytes(n: number) {
  if (n < 1024) return n.toLocaleString(getLanguage()) + " B";
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return (
    (n / 1024 ** i).toLocaleString(getLanguage(), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) +
    " " +
    ["B", "KiB", "MiB", "GiB"][i]
  );
}
export function handshake(timestamp: number) {
  if (!timestamp) return t("Ещё не было");
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  return seconds < 60
    ? seconds + t(" сек. назад")
    : seconds < 3600
      ? Math.floor(seconds / 60) + t(" мин. назад")
      : Math.floor(seconds / 3600) + t(" ч. назад");
}
