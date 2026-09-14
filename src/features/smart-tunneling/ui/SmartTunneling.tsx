import { useEffect, useRef, useState } from "react";
import { Globe2, Plus, X, Split } from "lucide-react";
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
  function add() {
    const values = entry.split(/[\s,]+/).filter(Boolean);
    if (!values.length) return;
    const entries = [...new Set([...settings.entries, ...values])];
    if (entries.length > 64) {
      setError(t("Максимум 64 адреса"));
      return;
    }
    setSettings({ ...settings, entries });
    setEntry("");
    setError("");
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      const entries = [
        ...new Set([
          ...settings.entries,
          ...entry.split(/[\s,]+/).filter(Boolean),
        ]),
      ];
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
  const mode = profile.smartTunneling?.mode || "off";
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
            {mode === "off"
              ? t("Маршруты конфигурации")
              : mode === "include"
                ? t("Только адреса из списка")
                : t("Кроме адресов из списка")}
          </small>
        </span>
        <span className="smart-count">
          {mode === "off"
            ? t("Настроить")
            : `${profile.smartTunneling?.entries.length || 0} · ${t("Настроить")}`}
        </span>
      </button>
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
              className={settings.mode === mode ? "selected" : ""}
            >
              <input
                type="radio"
                name="smart-mode"
                value={mode}
                checked={settings.mode === mode}
                onChange={() => setSettings({ ...settings, mode })}
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
        <p className="smart-description">
          {t(
            "Список сужает маршруты исходной конфигурации. Исключённый трафик может проходить через другое активное VPN-соединение.",
          )}
        </p>
        <fieldset
          className="smart-addresses"
          disabled={saving || !revision || locked || settings.mode === "off"}
        >
          <legend>
            <Globe2 size={16} /> {t("Домены и IP-адреса")}{" "}
            <span>{settings.entries.length}/64</span>
          </legend>
          <div className="smart-add">
            <input
              aria-label={t("Домен, IP-адрес или CIDR")}
              placeholder="example.com, 192.168.0.0/16"
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
              className="icon"
              aria-label={t("Добавить адрес")}
              onClick={add}
              disabled={!entry.trim()}
            >
              <Plus size={18} />
            </button>
          </div>
          <div className="smart-list">
            {!settings.entries.length && (
              <p>{t("Добавьте адреса для выбранного режима.")}</p>
            )}
            {settings.entries.map((value, index) => (
              <div key={value}>
                <code>{value}</code>
                <button
                  className="icon"
                  aria-label={t("Удалить адрес {address}", { address: value })}
                  onClick={() =>
                    setSettings({
                      ...settings,
                      entries: settings.entries.filter((_, i) => index !== i),
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
            "Домены разрешаются в IP при подключении. Для обновления адресов переподключитесь; поддомены добавляйте отдельно. Сайты с общим IP будут следовать одному правилу.",
          )}
        </p>
        <p className="smart-description">
          {t(
            "В режимах со списком используется системный DNS. Выбор отдельных приложений не поддерживается.",
          )}
        </p>
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
