import { useEffect, useState } from "react";
import { BrandIcon } from "@/shared/ui/brand-icon";
import { ArrowUpRight } from "lucide-react";
import { tunnelApi, useTunnels, type Profile } from "@/entities/tunnel";
import { useTunnelActions } from "@/features/manage-tunnels";
export function TrayPage() {
  const [appearance, setAppearance] = useState(0);
  useEffect(() => {
    const show = () => {
      if (!document.hidden) setAppearance((n) => n + 1);
    };
    document.addEventListener("visibilitychange", show);
    return () => document.removeEventListener("visibilitychange", show);
  }, []);
  const { data, setData, ready, error, setError } = useTunnels(1500);
  const { pending, perform } = useTunnelActions(setData, setError);
  const toggle = (profile: Profile) =>
    perform(
      () =>
        profile.statusUnknown
          ? tunnelApi.refreshStats()
          : tunnelApi.setActive(profile.id, !profile.active),
      profile.id,
    );
  return (
    <div className="tray-panel" key={appearance}>
      <div className="tray-heading">
        <BrandIcon size={46} />
        <div>
          <strong>WireGuard Desktop</strong>
          <p>
            {ready
              ? data.profiles.filter((p) => p.active).length +
                " активных туннелей"
              : "Загрузка…"}
          </p>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="tray-list">
        {data.helper.status !== "ready" && (
          <p>Откройте приложение для настройки системного доступа.</p>
        )}
        {data?.profiles.length === 0 && (
          <p>Добавьте конфигурацию в основном окне.</p>
        )}
        {data?.profiles.map((p) => {
          const busy = !!data.operations[p.id] || pending.includes(p.id);
          return (
            <div
              className="tray-tunnel"
              key={p.id}
              style={{ viewTransitionName: `tray-${p.id}` }}
            >
              <div>
                <strong>{p.name}</strong>
                <small>
                  <i className={p.active ? "online" : ""} />
                  {busy
                    ? "Выполняется операция…"
                    : p.statusUnknown
                      ? "Нужно проверить"
                      : p.active
                        ? "Интерфейс активен"
                        : "Отключён"}
                </small>
              </div>
              <button
                className={"tray-switch " + (p.active ? "on" : "")}
                role="switch"
                aria-checked={p.active}
                aria-label={
                  (p.statusUnknown
                    ? "Проверить "
                    : p.active
                      ? "Отключить "
                      : "Подключить ") + p.name
                }
                disabled={busy || !data.backend}
                aria-busy={busy}
                onClick={() => toggle(p)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tray-footer">
        <button className="primary" onClick={() => tunnelApi.openMain()}>
          Открыть приложение
          <ArrowUpRight size={16} />
        </button>
        <small>Закрытие окна оставляет клиент в строке меню.</small>
      </div>
    </div>
  );
}
