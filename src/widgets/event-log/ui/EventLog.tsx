import { t, message, getLanguage } from "@/shared/lib/i18n";
import { Terminal } from "lucide-react";
import type { State } from "@/entities/tunnel";
export function EventLog({ logs }: { logs: State["logs"] }) {
  return (
    <section className="journal">
      <div className="journal-head">
        <span>
          <Terminal size={16} /> {t("Журнал событий")}
        </span>
        <span>{t("ТЕКУЩИЙ СЕАНС")}</span>
      </div>
      <div className="log" aria-live="polite">
        {logs.length ? (
          logs.map((entry, i) => (
            <div key={i}>
              <time>
                {new Date(entry.time).toLocaleTimeString(getLanguage())}
              </time>
              <pre>{message(entry.message)}</pre>
            </div>
          ))
        ) : (
          <p>{t("События подключения появятся здесь.")}</p>
        )}
      </div>
    </section>
  );
}
