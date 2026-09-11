import { animate } from "@/shared/lib/view-transition";
import { Spinner } from "@/shared/ui/spinner";
import { BrandIcon } from "@/shared/ui/brand-icon";
import { Fragment, useRef, useState } from "react";
import {
  Plus,
  Power,
  ArrowUpRight,
  Trash2,
  Activity,
  Pencil,
  ChevronDown,
} from "lucide-react";
import { tunnelApi, useTunnels, type Profile } from "@/entities/tunnel";
import { ConfigEditor } from "@/features/edit-tunnel";
import { useTunnelActions } from "@/features/manage-tunnels";
import { TunnelNavigation } from "@/widgets/tunnel-navigation";
import { StatsPanel } from "@/widgets/tunnel-stats";
import { EventLog } from "@/widgets/event-log";
import { Card } from "@/shared/ui/card";
export function WorkspacePage() {
  const { data, setData, ready, error, setError } = useTunnels();
  const { pending, perform } = useTunnelActions(setData, setError);
  const connectionsPopover = useRef<HTMLDivElement>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [selected, select] = useState("");
  const [editor, setEditor] = useState<Profile | null>(null);
  const profile =
    data.profiles.find((p) => p.id === selected) || data.profiles[0];
  const busy = pending.includes("import");
  const operation =
    profile &&
    (data.operations[profile.id] ||
      (pending.includes(profile.id) ? "queued" : ""));
  const activeProfiles = data.profiles.filter((p) => p.active);
  return (
    <div className="shell">
      <TunnelNavigation
        data={data}
        profile={profile}
        pending={pending}
        ready={ready}
        busy={busy}
        select={(id) => animate(() => select(id))}
        onImport={() => perform(tunnelApi.import)}
      />
      <main>
        <header>
          <span>РАБОЧЕЕ ПРОСТРАНСТВО / VPN</span>
          <button
            className="local connections-trigger"
            popoverTarget="active-connections"
            aria-expanded={connectionsOpen}
            aria-controls="active-connections"
          >
            <i className={activeProfiles.length ? "online" : ""} />
            Активно: {activeProfiles.length} / {data.profiles.length}
            <ChevronDown size={13} />
          </button>
          <div
            id="active-connections"
            className="connections-popover"
            popover="auto"
            ref={connectionsPopover}
            onToggle={(event) => setConnectionsOpen(event.newState === "open")}
            role="region"
            aria-label="Активные соединения"
          >
            <strong>Активные соединения</strong>
            {activeProfiles.length ? (
              <div className="connections-list">
                {activeProfiles.map((p) => (
                  <div className="connection-row" key={p.id}>
                  <button
                    className="connection-select"
                    aria-current={p.id === profile?.id ? "true" : undefined}
                    onClick={() => {
                      connectionsPopover.current?.hidePopover();
                      if (p.id !== profile?.id) animate(() => select(p.id));
                    }}
                  >
                    <i className="online" />
                    <span>{p.name}</span>
                    <ArrowUpRight size={14} />
                  </button>
                  <button
                    className={"tray-switch " + (p.active ? "on" : "")}
                    role="switch"
                    aria-checked={p.active}
                    aria-label={(p.active ? "Отключить " : "Подключить ") + p.name}
                    aria-busy={!!data.operations[p.id] || pending.includes(p.id)}
                    disabled={!!data.operations[p.id] || pending.includes(p.id) || !data.backend}
                    onClick={() => perform(() => tunnelApi.setActive(p.id, !p.active), p.id)}
                  >
                    <span />
                  </button>
                  </div>
                ))}
              </div>
            ) : (
              <p>Нет активных туннелей</p>
            )}
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => animate(() => setError(""))}>×</button>
          </div>
        )}
        {ready && data.helper.status !== "ready" && (
          <div className="helper-notice" role="status">
            <div>
              <strong>
                {data.helper.status === "installing"
                  ? "Настройка системного доступа…"
                  : "Нужен системный помощник"}
              </strong>
              <p>
                {data.helper.message ||
                  "Один запрос администратора при установке. Затем VPN работает без повторного ввода пароля."}
              </p>
            </div>
            <button
              className="primary"
              disabled={
                data.helper.status === "installing" ||
                pending.includes("helper")
              }
              onClick={() => perform(tunnelApi.setupHelper, "helper")}
            >
              {data.helper.status === "installing" ? (
                <Spinner />
              ) : (
                "Настроить доступ"
              )}
            </button>
          </div>
        )}
        {profile ? (
          <Fragment key={profile.id}>
            <div className="title">
              <div>
                <h1>{profile.name}</h1>
                <p>Ваше соединение. Под вашим контролем.</p>
              </div>
              <div className="title-actions">
                <button
                  className="icon"
                  disabled={!!operation}
                  onClick={() => animate(() => setEditor(profile))}
                >
                  <Pencil size={16} />
                  Редактировать
                </button>
                <button
                  aria-label="Удалить туннель"
                  className="icon"
                  disabled={
                    !!operation || profile.active || profile.statusUnknown
                  }
                  onClick={() =>
                    perform(() => tunnelApi.remove(profile.id), profile.id)
                  }
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
            <section
              className={"connection " + (profile.active ? "connected" : "")}
            >
              <div className="shield">
                <BrandIcon size={64} />
              </div>
              <div>
                <div className="eyebrow">СОСТОЯНИЕ ТУННЕЛЯ</div>
                <h2>
                  {operation
                    ? operation.startsWith("queued")
                      ? "В очереди…"
                      : "Выполняется операция…"
                    : profile.statusUnknown
                      ? "Нужно проверить состояние"
                      : profile.active
                        ? "Интерфейс активен"
                        : "Готов к подключению"}
                </h2>
                <p>
                  {profile.statusUnknown
                    ? "Обнаружен системный туннель. Обновите его состояние через помощник."
                    : profile.active
                      ? "Туннель поднят. Доступность сервера не проверена."
                      : "Подключитесь, когда нужен защищённый маршрут."}
                </p>
              </div>
              <button
                className="primary"
                disabled={!!operation || !data.backend}
                aria-busy={!!operation}
                onClick={() =>
                  perform(
                    () =>
                      profile.statusUnknown
                        ? tunnelApi.refreshStats()
                        : tunnelApi.setActive(profile.id, !profile.active),
                    profile.id,
                  )
                }
              >
                {operation ? <Spinner /> : <Power size={16} />}
                {operation
                  ? "Ожидайте…"
                  : profile.statusUnknown
                    ? "Проверить"
                    : profile.active
                      ? "Отключить"
                      : "Подключить"}
              </button>
            </section>
            {profile.notes.length > 0 && (
              <div className="route-notes">
                {profile.notes.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
              </div>
            )}
            <div className="details">
              <Card label="АДРЕС ТУННЕЛЯ" value={profile.address} />
              <Card label="DNS" value={profile.dns} />
              <Card label="ENDPOINT" value={profile.endpoint} />
              <Card label="МАРШРУТЫ" value={profile.allowedIPs} />
            </div>
            <StatsPanel
              profile={profile}
              pending={data.statsBusy || pending.includes("stats")}
              refresh={() => perform(tunnelApi.refreshStats, "stats")}
            />
            <div className="hint">
              <Activity size={15} />
              {profile.peers} peer · Состояние обновляется каждые 2,5 секунды
            </div>
          </Fragment>
        ) : (
          <section className="empty">
            <div className="empty-icon">
              <BrandIcon size={88} />
            </div>
            <span className="eyebrow">ПРОСТОЕ УПРАВЛЕНИЕ WIREGUARD</span>
            <h1>
              Меньше шума.
              <br />
              Больше контроля.
            </h1>
            <p>
              Добавьте конфигурацию WireGuard,
              <br />
              чтобы управлять подключением из одного окна.
            </p>
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() => perform(tunnelApi.import)}
            >
              <Plus size={18} />
              Добавить туннель
              <ArrowUpRight size={17} />
            </button>
            <small>Файл .conf · Ключи остаются на вашем Mac</small>
          </section>
        )}
        <EventLog logs={data.logs} />
        <footer>
          Изменения маршрутов выполняются по очереди. Подключённые туннели
          работают параллельно.
        </footer>
      </main>
      {editor && (
        <ConfigEditor
          profile={editor}
          close={() => animate(() => setEditor(null))}
          saved={(s) => {
            setData(s);
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}
