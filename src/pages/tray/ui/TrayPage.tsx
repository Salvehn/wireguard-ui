import { ViewTransition } from "react";
import { t, message } from "@/shared/lib/i18n";
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
    perform(async () => {
      if (!data.backend) {
        const state = await tunnelApi.setupHelper();
        if (state.helper.status !== "ready") return state;
      }
      return profile.statusUnknown
        ? tunnelApi.refreshStats()
        : tunnelApi.setActive(profile.id, !profile.active);
    }, profile.id);
  return (
    <div className="tray-panel" key={appearance}>
      <ViewTransition update="panel">
        <div className="tray-heading">
          <BrandIcon size={46} />
          <div>
            <strong>WireGuard Desktop</strong>
            <p>
              {ready
                ? t("Активных туннелей: {count}", {
                    count: data.profiles.filter((p) => p.active).length,
                  })
                : t("Загрузка…")}
            </p>
          </div>
        </div>
      </ViewTransition>
      {error && (
        <div className="error" role="alert">
          {message(error)}
        </div>
      )}
      <div className="tray-list">
        {data?.profiles.length === 0 && (
          <p>{t("Добавьте конфигурацию в основном окне.")}</p>
        )}
        {data?.profiles.map((p) => {
          const busy = !!data.operations[p.id] || pending.includes(p.id);
          return (
            <ViewTransition key={p.id} update="panel">
              <div className="tray-tunnel">
                <div>
                  <strong>{p.name}</strong>
                  <small>
                    <i className={p.active ? "online" : ""} />
                    {busy
                      ? t("Выполняется операция…")
                      : p.statusUnknown
                        ? t("Нужно проверить")
                        : p.active
                          ? t("Интерфейс активен")
                          : t("Отключён")}
                  </small>
                </div>
                <button
                  className={"tray-switch " + (p.active ? "on" : "")}
                  role="switch"
                  aria-checked={p.active}
                  aria-label={
                    (!data.backend
                      ? t("Разрешить управление VPN") + ": "
                      : p.statusUnknown
                        ? t("Проверить ")
                        : p.active
                          ? t("Отключить ")
                          : t("Подключить ")) + p.name
                  }
                  disabled={busy || data.helper.status === "installing"}
                  aria-busy={busy}
                  onClick={() => toggle(p)}
                >
                  <span />
                </button>
              </div>
            </ViewTransition>
          );
        })}
      </div>
      <ViewTransition update="panel">
        <div className="tray-footer">
          <button className="primary" onClick={() => tunnelApi.openMain()}>
            {t("Открыть приложение")}
            <ArrowUpRight size={16} />
          </button>
          <small>{t("Закрытие окна оставляет клиент в строке меню.")}</small>
        </div>
      </ViewTransition>
    </div>
  );
}
