import { useState } from "react";
import { Languages } from "lucide-react";
import {
  setLanguage,
  t,
  useLocale,
  type LanguagePreference,
} from "@/shared/lib/i18n";
export function LanguageSwitcher() {
  const { preference } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="language-control">
      <label className="language-picker" title={t("Язык")}>
        <Languages size={14} aria-hidden="true" />
        <select
          aria-label={t("Язык")}
          value={preference}
          disabled={pending}
          onChange={async (event) => {
            const next = event.target.value as LanguagePreference;
            setPending(true);
            setError(false);
            try {
              await setLanguage(next);
            } catch {
              setError(true);
            } finally {
              setPending(false);
            }
          }}
        >
          <option value="system">{t("Системный")}</option>
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
      </label>
      {error && (
        <p className="language-error" role="alert">
          {t("Не удалось сохранить язык. Попробуйте ещё раз.")}
        </p>
      )}
    </div>
  );
}
