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
          <strong>Связь с peers</strong>
          <p>
            {profile.interfaceName || "Интерфейс не поднят"}
            {stats
              ? " · Обновлено " +
                new Date(stats.updatedAt).toLocaleTimeString("ru")
              : ""}
          </p>
        </div>
        <button
          className="icon"
          disabled={(!profile.active && !profile.statusUnknown) || pending}
          onClick={refresh}
        >
          <span style={{ width: 14, height: 14 }}>{pending && <Spinner />}</span>
          Обновить статистику
        </button>
      </div>
      {!stats ? (
        <p className="stats-empty">
          {profile.active || profile.statusUnknown
            ? "Помощник получает handshake и трафик автоматически. Можно обновить данные сейчас."
            : "Handshake и трафик доступны после подключения."}
        </p>
      ) : (
        <>
          <div className="traffic">
            <Card
              label="ПОЛУЧЕНО ↓"
              value={bytes(stats.peers.reduce((sum, p) => sum + p.rx, 0))}
            />
            <Card
              label="ОТПРАВЛЕНО ↑"
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
                    ? "Нет handshake"
                    : Date.now() / 1000 - peer.lastHandshake < 180
                      ? "Недавний handshake"
                      : "Давно нет handshake"}
                </span>
              </div>
              <dl>
                <dt>Последний handshake</dt>
                <dd>{handshake(peer.lastHandshake)}</dd>
                <dt>Endpoint</dt>
                <dd>{peer.endpoint}</dd>
                <dt>Получено / отправлено</dt>
                <dd>
                  {bytes(peer.rx)} / {bytes(peer.tx)}
                </dd>
                <dt>Keepalive</dt>
                <dd>
                  {peer.keepalive === "off"
                    ? "Выключен"
                    : peer.keepalive + " сек."}
                </dd>
                <dt>Allowed IPs</dt>
                <dd>{peer.allowedIPs}</dd>
              </dl>
            </div>
          ))}
          <p className="stats-empty">
            Счётчики с момента запуска интерфейса. Давний handshake может
            означать отсутствие трафика; это не проверка интернета.
          </p>
        </>
      )}
    </section>
  );
}
