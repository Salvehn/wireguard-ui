import { useState } from "react";
import { SunMoon } from "lucide-react";
import { t } from "@/shared/lib/i18n";
import { setTheme, useTheme, type ThemePreference } from "@/shared/lib/theme";
import { Select } from "@/shared/ui/select";
export function ThemeSwitcher() {
  const { preference } = useTheme();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="theme-control">
      <Select
        icon={<SunMoon size={14} aria-hidden="true" />}
        label={t("Тема")}
        value={preference}
        disabled={pending}
        options={[
          { value: "system", label: t("Системная") },
          { value: "light", label: t("Светлая") },
          { value: "dark", label: t("Тёмная") },
        ]}
        onChange={(next) =>
          void (async () => {
            setPending(true);
            setError(false);
            try {
              await setTheme(next as ThemePreference);
            } catch {
              setError(true);
            } finally {
              setPending(false);
            }
          })()
        }
      />
      {error && (
        <p className="theme-error" role="alert">
          {t("Не удалось сохранить тему. Попробуйте ещё раз.")}
        </p>
      )}
    </div>
  );
}
