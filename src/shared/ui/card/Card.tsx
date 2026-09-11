import { t } from "@/shared/lib/i18n";
export function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <span>{label}</span>
      <div>{value || t("Не указан")}</div>
    </div>
  );
}
