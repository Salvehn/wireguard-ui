import { useEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw, RotateCcw, X } from "lucide-react";
import { t, message } from "@/shared/lib/i18n";
import { Spinner } from "@/shared/ui/spinner";
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  useAppUpdate,
} from "../model/use-app-update";

function size(bytes: number) {
  if (!bytes) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function AppUpdate() {
  const state = useAppUpdate();
  const [open, setOpen] = useState(false);
  const previousStatus = useRef(state.status);
  useEffect(() => {
    if (
      previousStatus.current !== state.status &&
      (state.status === "available" ||
        state.status === "downloaded" ||
        state.status === "error")
    ) {
      setOpen(true);
    }
    previousStatus.current = state.status;
  }, [state.status]);

  const working =
    state.status === "checking" ||
    state.status === "downloading" ||
    state.status === "installing";
  const available =
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded" ||
    state.status === "installing";
  const title = !state.supported
    ? t("Доступны обновления")
    : state.status === "checking"
      ? t("Проверяем обновления…")
      : state.status === "up-to-date"
        ? t("Установлена последняя версия")
        : state.status === "available"
          ? t("Доступна версия {version}", {
              version: state.availableVersion || "",
            })
          : state.status === "downloading"
            ? t("Загрузка версии {version}", {
                version: state.availableVersion || "",
              })
            : state.status === "downloaded"
              ? t("Обновление готово к установке")
              : state.status === "installing"
                ? t("Подготовка к перезапуску…")
                : state.status === "error"
                  ? t("Не удалось обновить приложение")
                  : t("Обновления приложения");

  return (
    <div className="app-update">
      <button
        className={`version-button ${available ? "update-available" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={t("Версия {version}. Проверить обновления", {
          version: state.currentVersion,
        })}
      >
        <span>
          {t("Версия {version}", { version: state.currentVersion || "…" })}
        </span>
        {working ? (
          <Spinner />
        ) : available ? (
          <Download size={13} />
        ) : state.status === "up-to-date" ? (
          <Check size={13} />
        ) : (
          <RefreshCw size={13} />
        )}
      </button>
      {open && (
        <section className="update-panel" aria-live="polite">
          <div className="update-panel-heading">
            <strong>{title}</strong>
            <button
              className="update-close"
              aria-label={t("Закрыть")}
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </button>
          </div>
          {state.status === "downloading" && (
            <>
              <div
                className="update-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(state.percent)}
              >
                <span style={{ width: `${state.percent}%` }} />
              </div>
              <p className="update-metrics">
                {Math.round(state.percent)}% · {size(state.transferred)} /{" "}
                {size(state.total)}
                {state.bytesPerSecond
                  ? ` · ${size(state.bytesPerSecond)}/${t("с")}`
                  : ""}
              </p>
            </>
          )}
          {state.status === "downloaded" && (
            <p>{t("Приложение отключит активные туннели и перезапустится.")}</p>
          )}
          {state.status === "installing" && (
            <p>{t("Отключаем активные туннели перед установкой.")}</p>
          )}
          {state.status === "error" && state.error && (
            <p className="update-error">{message(state.error)}</p>
          )}
          {!state.supported && (
            <p>{t("Проверка работает после установки приложения из DMG.")}</p>
          )}
          {state.supported &&
            (state.status === "idle" ||
              state.status === "up-to-date" ||
              state.status === "error") && (
              <button className="update-action" onClick={checkForUpdates}>
                <RefreshCw size={14} /> {t("Проверить обновления")}
              </button>
            )}
          {state.status === "available" && (
            <button className="update-action" onClick={downloadUpdate}>
              <Download size={14} /> {t("Скачать обновление")}
            </button>
          )}
          {state.status === "downloaded" && (
            <button className="update-action primary" onClick={installUpdate}>
              <RotateCcw size={14} /> {t("Перезапустить и установить")}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
