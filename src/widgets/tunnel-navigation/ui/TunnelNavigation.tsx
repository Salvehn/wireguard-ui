import { ViewTransition } from "react";
import { t } from "@/shared/lib/i18n";
import { BrandIcon } from "@/shared/ui/brand-icon";
import { Plus, Network } from "lucide-react";
import type { Profile, State } from "@/entities/tunnel";
import { AppUpdate } from "@/features/update-app";
export function TunnelNavigation({
  data,
  profile,
  pending,
  busy,
  select,
  onImport,
}: {
  data: State;
  profile: Profile | undefined;
  pending: string[];
  busy: boolean;
  select: (id: string) => void;
  onImport: () => void;
}) {
  return (
    <aside>
      <ViewTransition update="panel">
        <div className="brand">
          <BrandIcon size={46} />
          <strong>
            WireGuard Desktop<span>DESKTOP CLIENT</span>
          </strong>
        </div>
      </ViewTransition>
      <div className="section-label">
        {t("ТУННЕЛИ")}
        <span>{data.profiles.length}</span>
      </div>
      <nav>
        {data.profiles.map((p) => (
          <ViewTransition key={p.id} update="panel">
            <button
              className={"tunnel " + (profile?.id === p.id ? "selected" : "")}
              onClick={() => select(p.id)}
            >
              <Network size={18} />
              <span>
                {p.name}
                <small>
                  {data.operations[p.id] || pending.includes(p.id)
                    ? t("Выполняется операция…")
                    : p.statusUnknown
                      ? t("Нужно проверить")
                      : p.active
                        ? t("Интерфейс активен")
                        : t("Отключён")}
                </small>
              </span>
              <i className={p.active ? "online" : ""} />
            </button>
          </ViewTransition>
        ))}
      </nav>
      <button className="import" disabled={busy} onClick={onImport}>
        <Plus size={17} /> {t("Импорт конфигурации")}
      </button>
      <AppUpdate platform={data.platform} />
    </aside>
  );
}
