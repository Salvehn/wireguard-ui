import { t, getLanguage } from "@/shared/lib/i18n";
import { Spinner } from "@/shared/ui/spinner";
import type { Profile } from "@/entities/tunnel";
import { Card } from "@/shared/ui/card";
import { bytes, handshake } from "@/shared/lib/format";
export function StatsPanel({
  profile,
  pending,
  refresh,
}: {
  profile: Profile;
  pending: boolean;
  refresh: () => void;
}) {
  const stats = profile.stats;
  return (
    <section className="stats-panel">
      <div className="stats-heading">
        <div>
          <strong>{t("Связь с peers")}</strong>
          <p>
            {profile.appRouting
              ? t("Маршрутизация по приложениям")
              : profile.interfaceName || t("Интерфейс не поднят")}
            {stats
              ? t(" · Обновлено ") +
                new Date(stats.updatedAt).toLocaleTimeString(getLanguage())
              : ""}
          </p>
        </div>
        <button
          className="icon"
          disabled={
            profile.appRouting ||
            (!profile.active && !profile.statusUnknown) ||
            pending
          }
          onClick={refresh}
        >
          <span style={{ width: 14, height: 14 }}>
            {pending && <Spinner />}
          </span>
          {t("Обновить статистику")}
        </button>
      </div>
      {!stats ? (
        <p className="stats-empty">
          {profile.appRouting
            ? t("Статистика WireGuard в режиме приложений недоступна.")
            : profile.active || profile.statusUnknown
              ? t(
                  "Помощник получает handshake и трафик автоматически. Можно обновить данные сейчас.",
                )
              : t("Handshake и трафик доступны после подключения.")}
        </p>
      ) : (
        <>
          <div className="traffic">
            <Card
              label={t("ПОЛУЧЕНО ↓")}
              value={bytes(stats.peers.reduce((sum, p) => sum + p.rx, 0))}
            />
            <Card
              label={t("ОТПРАВЛЕНО ↑")}
              value={bytes(stats.peers.reduce((sum, p) => sum + p.tx, 0))}
            />
          </div>
          {stats.peers.map((peer) => (
            <div
              className="peer"
              key={peer.publicKey}
              style={{
                viewTransitionName: `peer-${peer.publicKey.replaceAll("+", "-p").replaceAll("/", "-s").replaceAll("=", "-e")}`,
              }}
            >
              <div className="peer-title">
                <code>{peer.publicKey.slice(0, 12)}…</code>
                <span
                  className={
                    peer.lastHandshake &&
                    Date.now() / 1000 - peer.lastHandshake < 180
                      ? "fresh"
                      : "stale"
                  }
                >
                  {!peer.lastHandshake
                    ? t("Нет handshake")
                    : Date.now() / 1000 - peer.lastHandshake < 180
                      ? t("Недавний handshake")
                      : t("Давно нет handshake")}
                </span>
              </div>
              <dl>
                <dt>{t("Последний handshake")}</dt>
                <dd>{handshake(peer.lastHandshake)}</dd>
                <dt>Endpoint</dt>
                <dd>{peer.endpoint}</dd>
                <dt>{t("Получено / отправлено")}</dt>
                <dd>
                  {bytes(peer.rx)} / {bytes(peer.tx)}
                </dd>
                <dt>Keepalive</dt>
                <dd>
                  {peer.keepalive === "off"
                    ? t("Выключен")
                    : peer.keepalive + t(" сек.")}
                </dd>
                <dt>Allowed IPs</dt>
                <dd>{peer.allowedIPs}</dd>
              </dl>
            </div>
          ))}
          <p className="stats-empty">
            {t(
              "Счётчики с момента запуска интерфейса. Давний handshake может означать отсутствие трафика; это не проверка интернета.",
            )}
          </p>
        </>
      )}
    </section>
  );
}
