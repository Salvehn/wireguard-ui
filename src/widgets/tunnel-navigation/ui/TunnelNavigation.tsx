import { t } from "@/shared/lib/i18n";
import { BrandIcon } from "@/shared/ui/brand-icon";
import { Plus, Network } from "lucide-react";
import type { Profile, State } from "@/entities/tunnel";
import { AppUpdate } from "@/features/update-app";
export function TunnelNavigation({
  data,
  profile,
  pending,
  ready,
  busy,
  select,
  onImport,
}: {
  data: State;
  profile: Profile | undefined;
  pending: string[];
  ready: boolean;
  busy: boolean;
  select: (id: string) => void;
  onImport: () => void;
}) {
  return (
    <aside>
      <div className="brand">
        <BrandIcon size={46} />
        <strong>
          WireGuard Desktop<span>DESKTOP CLIENT</span>
        </strong>
      </div>
      <div className="section-label">
        {t("ТУННЕЛИ")}
        <span>{data.profiles.length}</span>
      </div>
      <nav>
        {data.profiles.map((p) => (
          <button
            key={p.id}
            style={{ viewTransitionName: `nav-${p.id}` }}
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
        ))}
      </nav>
      <button className="import" disabled={busy} onClick={onImport}>
        <Plus size={17} /> {t("Импорт конфигурации")}
      </button>
      <div className="sidebar-foot">
        <i className={data.backend ? "online" : ""} />
        {!ready
          ? t("Проверка backend…")
          : data.backend
            ? t("Системный помощник готов")
            : t("Нужен системный доступ")}
      </div>
      <AppUpdate />
    </aside>
  );
}
