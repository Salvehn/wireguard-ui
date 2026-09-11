export function bytes(n: number) {
  if (n < 1024) return n + " B";
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(1) + " " + ["B", "KiB", "MiB", "GiB"][i];
}
export function handshake(timestamp: number) {
  if (!timestamp) return "Ещё не было";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  return seconds < 60
    ? seconds + " сек. назад"
    : seconds < 3600
      ? Math.floor(seconds / 60) + " мин. назад"
      : Math.floor(seconds / 3600) + " ч. назад";
}
