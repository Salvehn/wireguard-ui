import { useEffect, useRef, useState } from "react";
import { Globe2, Plus, X, Split, AppWindow } from "lucide-react";
import type { Profile, State, SmartTunnelingSettings } from "@/entities/tunnel";
import { t, message } from "@/shared/lib/i18n";

export function SmartTunneling({
  profile,
  pending,
  saved,
}: {
  profile: Profile;
  pending: boolean;
  saved: (state: State) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<SmartTunnelingSettings>({
    mode: "off",
    entries: [],
  });
  const [revision, setRevision] = useState("");
  const [initial, setInitial] = useState("");
  const [entry, setEntry] = useState("");
  const [allSubdomains, setAllSubdomains] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [open, setOpen] = useState(false);
  const locked = pending || profile.active || profile.statusUnknown;
  const dirty = JSON.stringify(settings) !== initial || !!entry.trim();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRevision("");
    setError("");
    setEntry("");
    setAllSubdomains(false);
    setDiscard(false);
    window.wireguard
      .readSmartTunneling(profile.id)
      .then((result) => {
        if (!alive) return;
        setSettings(result.settings);
        setInitial(JSON.stringify(result.settings));
        setRevision(result.revision);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [open, profile.id]);
  function close() {
    if (saving) return;
    if (revision && dirty) {
      setDiscard(true);
      return;
    }
    dismiss();
  }
  function dismiss() {
    dialog.current?.close();
    setOpen(false);
  }
  function pendingEntries() {
    return entry
      .split(/[\s,]+/)
      .filter(Boolean)
      .flatMap((value) => {
        const domain = value
          .toLowerCase()
          .replace(/^\*\./, "")
          .replace(/\.$/, "");
        const isDomain =
          domain.includes(".") &&
          !/[\s/:*?#@\\%]/.test(domain) &&
          !/^[\d.]+$/.test(domain);
        return allSubdomains && isDomain ? [domain, `*.${domain}`] : [value];
      });
  }
  function mergedEntries() {
    const values = pendingEntries();
    const entries = [...new Set([...settings.entries, ...values])];
    if (entries.length > 64) throw Error(t("Максимум 64 адреса"));
    return entries;
  }
  function add() {
    if (!entry.trim()) return;
    try {
      setSettings({ ...settings, entries: mergedEntries() });
      setEntry("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      const entries = mergedEntries();
      saved(
        await window.wireguard.saveSmartTunneling(
          profile.id,
          { ...settings, entries },
          revision,
        ),
      );
      dismiss();
    } catch (e) {
      setError(message((e as Error).message));
    } finally {
      setSaving(false);
    }
  }
  const apps = settings.applications || { mode: "off" as const, paths: [] };
  const appsActive = apps.mode !== "off";
  async function chooseApps() {
    try {
      const paths = [
        ...new Set([
          ...apps.paths,
          ...(await window.wireguard.chooseApplications()),
        ]),
      ];
      if (paths.length > 64) throw Error(t("Максимум 64 приложения"));
      setSettings({ ...settings, applications: { ...apps, paths } });
      setError("");
    } catch (e) {
      setError(message((e as Error).message));
    }
  }
  const mode = profile.smartTunneling?.mode || "off";
  const profileApps = profile.smartTunneling?.applications;

  return (
    <>
      <button
        className="smart-summary"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        <Split size={20} />
        <span>
          <strong>Smart tunneling</strong>
          <small>
            {profileApps?.mode && profileApps.mode !== "off"
              ? profileApps.mode === "include"
                ? t("Только выбранные приложения")
                : t("Кроме выбранных приложений")
              : mode === "off"
                ? t("Маршруты конфигурации")
                : mode === "include"
                  ? t("Только адреса из списка")
                  : t("Кроме адресов из списка")}
          </small>
        </span>
        <span className="smart-count">
          {profileApps?.mode && profileApps.mode !== "off"
            ? `${profileApps.paths.length} · ${t("Настроить")}`
            : mode === "off"
              ? t("Настроить")
              : `${profile.smartTunneling?.entries.length || 0} · ${t("Настроить")}`}
        </span>
      </button>
      {profile.smartError && (
        <div className="error" role="alert">
          {message(profile.smartError)}
        </div>
      )}
      <dialog
        className="smart-dialog"
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        aria-labelledby="smart-title"
      >
        <div className="editor-heading">
          <div>
            <h2 id="smart-title">Smart tunneling</h2>
            <p>{profile.name}</p>
          </div>
          <button
            className="icon"
            aria-label={t("Закрыть")}
            disabled={saving}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <div className="smart-dialog-body">
          <p className="smart-description">
            {t("Выберите, какой трафик направлять через это соединение.")}
          </p>
          <fieldset
            disabled={saving || !revision || locked}
            className="smart-modes"
          >
            <legend>{t("Режим туннелирования")}</legend>
            {(["off", "exclude", "include"] as const).map((mode) => (
              <label
                key={mode}
                className={
                  !appsActive && settings.mode === mode ? "selected" : ""
                }
              >
                <input
                  type="radio"
                  name="smart-mode"
                  value={mode}
                  checked={!appsActive && settings.mode === mode}
                  onChange={() =>
                    setSettings({
                      ...settings,
                      mode,
                      applications: { ...apps, mode: "off" },
                    })
                  }
                />
                <span>
                  {mode === "off"
                    ? t("Маршруты конфигурации")
                    : mode === "exclude"
                      ? t("Кроме адресов из списка")
                      : t("Только адреса из списка")}
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset
            className="smart-modes"
            disabled={saving || !revision || locked}
          >
            <legend>
              <AppWindow size={16} /> {t("Приложения")}
            </legend>
            {(["include", "exclude"] as const).map((mode) => (
              <label
                key={mode}
                className={apps.mode === mode ? "selected" : ""}
              >
                <input
                  type="radio"
                  name="smart-mode"
                  checked={apps.mode === mode}
                  onChange={() => {
                    setEntry("");
                    setSettings({
                      ...settings,
                      mode: "off",
                      applications: { ...apps, mode },
                    });
                  }}
                />
                <span>
                  {mode === "include"
                    ? t("Только выбранные приложения")
                    : t("Кроме выбранных приложений")}
                </span>
              </label>
            ))}
          </fieldset>
          {appsActive && (
            <>
              <fieldset
                className="smart-addresses"
                disabled={saving || !revision || locked}
              >
                <legend>
                  {t("Выбранные приложения")}{" "}
                  <span>{apps.paths.length}/64</span>
                </legend>
                <button className="icon" onClick={chooseApps}>
                  <Plus size={16} /> {t("Выбрать приложения…")}
                </button>
                <div className="smart-list">
                  {apps.paths.map((appPath) => (
                    <div key={appPath}>
                      <code title={appPath}>
                        {appPath
                          .split("/")
                          .at(-1)
                          ?.replace(/\.app$/, "")}
                      </code>
                      <button
                        className="icon"
                        aria-label={t("Удалить приложение {name}", {
                          name: appPath,
                        })}
                        onClick={() =>
                          setSettings({
                            ...settings,
                            applications: {
                              ...apps,
                              paths: apps.paths.filter((p) => p !== appPath),
                            },
                          })
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </fieldset>
              <p className="smart-description">
                {t(
                  "Можно включать несколько соединений. Рабочие подсети обычных VPN сохраняют приоритет; для совпадающих правил приложений используется последнее подключённое соединение.",
                )}
              </p>
              <p className="smart-description">
                {t(
                  "Учитываются процессы внутри выбранного .app. Общие системные службы могут не определяться как часть приложения. После подключения перезапустите выбранные приложения.",
                )}
              </p>
              <p className="smart-description">
                {t(
                  "Системный DNS следует обычным маршрутам. При изменении соединений или доменных маршрутов возможен краткий перерыв в трафике приложений. Статистика WireGuard в этом режиме недоступна.",
                )}
              </p>
            </>
          )}
          {!appsActive && (
            <>
              <p className="smart-description">
                {t(
                  "Список сужает маршруты исходной конфигурации. Исключённый трафик может проходить через другое активное VPN-соединение.",
                )}
              </p>
              <fieldset
                className="smart-addresses"
                disabled={
                  saving || !revision || locked || settings.mode === "off"
                }
              >
                <legend>
                  <Globe2 size={16} /> {t("Домены и IP-адреса")}{" "}
                  <span>{settings.entries.length}/64</span>
                </legend>
                <div className="smart-add">
                  <input
                    aria-label={t("Домен, IP-адрес или CIDR")}
                    placeholder="example.com, *.example.com, 192.168.0.0/16"
                    value={entry}
                    maxLength={4096}
                    onChange={(event) => setEntry(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        add();
                      }
                    }}
                  />
                  <button
                    className="icon smart-entry-action"
                    aria-label={t("Добавить адрес")}
                    onClick={add}
                    disabled={!entry.trim()}
                  >
                    <Plus size={18} />
                  </button>
                </div>
                <label className="smart-subdomains">
                  <input
                    type="checkbox"
                    checked={allSubdomains}
                    onChange={(event) => setAllSubdomains(event.target.checked)}
                  />
                  {t("Все поддомены")}
                </label>
                <div className="smart-list">
                  {!settings.entries.length && (
                    <p>{t("Добавьте адреса для выбранного режима.")}</p>
                  )}
                  {settings.entries.map((value, index) => (
                    <div key={value}>
                      <code>{value}</code>
                      {value.includes(".") &&
                        !/[\s/:*]/.test(value) &&
                        !/^[\d.]+$/.test(value) &&
                        !settings.entries.includes(`*.${value}`) && (
                          <button
                            className="icon"
                            disabled={settings.entries.length >= 64}
                            aria-label={t("Добавить поддомены {name}", {
                              name: value,
                            })}
                            onClick={() =>
                              setSettings({
                                ...settings,
                                entries: [...settings.entries, `*.${value}`],
                              })
                            }
                          >
                            <Plus size={13} />
                            {t("Поддомены")}
                          </button>
                        )}
                      <button
                        className="icon smart-entry-action"
                        aria-label={t("Удалить адрес {address}", {
                          address: value,
                        })}
                        onClick={() =>
                          setSettings({
                            ...settings,
                            entries: settings.entries.filter(
                              (_, i) => index !== i,
                            ),
                          })
                        }
                      >
                        <X size={18} />
                      </button>
                    </div>
                  ))}
                </div>
              </fieldset>
              <p className="smart-description">
                {t(
                  "*.example.com охватывает поддомены любого уровня, но не сам example.com. Добавьте обе записи, чтобы включить домен целиком.",
                )}
              </p>
              <p className="smart-description">
                {t("В режимах со списком используется системный DNS.")}
              </p>
              <p className="smart-description">
                {t(
                  "Маски применяются к системным DNS-запросам во время соединения. Полученные IP сохраняются до отключения; сайты с общим IP следуют одному правилу. Приложения с собственным DNS-over-HTTPS могут обходить эти правила.",
                )}
              </p>
              <p className="smart-description">
                {t(
                  "Для масок требуется обновлённый системный помощник. macOS может запросить пароль администратора при его установке.",
                )}
              </p>
            </>
          )}
          {locked && (
            <p className="editor-note">
              {t(
                "Для изменения настроек отключите это соединение и дождитесь завершения операции.",
              )}
            </p>
          )}
          {error && (
            <div className="error" role="alert">
              {message(error)}
            </div>
          )}
        </div>
        <div className="editor-actions">
          {discard ? (
            <>
              <span>{t("Отменить несохранённые изменения?")}</span>
              <button className="icon" onClick={() => setDiscard(false)}>
                {t("Продолжить")}
              </button>
              <button className="icon" onClick={dismiss}>
                {t("Отменить изменения")}
              </button>
            </>
          ) : (
            <>
              <button className="icon" disabled={saving} onClick={close}>
                {t("Отмена")}
              </button>
              <button
                className="primary"
                disabled={locked || !revision || saving || !dirty}
                onClick={save}
              >
                {saving ? t("Сохранение…") : t("Сохранить")}
              </button>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
