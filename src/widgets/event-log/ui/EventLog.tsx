import { Terminal } from "lucide-react";
import type { State } from "@/entities/tunnel";
export function EventLog({ logs }: { logs: State["logs"] }) {
  return (
    <section className="journal">
      <div className="journal-head">
        <span>
          <Terminal size={16} /> Журнал событий
        </span>
        <span>ТЕКУЩИЙ СЕАНС</span>
      </div>
      <div className="log" aria-live="polite">
        {logs.length ? (
          logs.map((entry, i) => (
            <div key={i}>
              <time>{entry.time}</time>
              <pre>{entry.message}</pre>
            </div>
          ))
        ) : (
          <p>События подключения появятся здесь.</p>
        )}
      </div>
    </section>
  );
}
