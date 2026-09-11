import { useState } from "react";
import { Languages } from "lucide-react";
import {
  setLanguage,
  t,
  useLocale,
  type LanguagePreference,
} from "@/shared/lib/i18n";
import { Select } from "@/shared/ui/select";
export function LanguageSwitcher() {
  const { preference } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="language-control">
      <Select
        icon={<Languages size={14} aria-hidden="true" />}
        label={t("Язык")}
        value={preference}
        disabled={pending}
        options={[
          { value: "system", label: t("Системный") },
          { value: "ru", label: "Русский" },
          { value: "en", label: "English" },
        ]}
        onChange={(next) =>
          void (async () => {
            setPending(true);
            setError(false);
            try {
              await setLanguage(next as LanguagePreference);
            } catch {
              setError(true);
            } finally {
              setPending(false);
            }
          })()
        }
      />
      {error && (
        <p className="language-error" role="alert">
          {t("Не удалось сохранить язык. Попробуйте ещё раз.")}
        </p>
      )}
    </div>
  );
}
