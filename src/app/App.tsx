import { WorkspacePage } from "@/pages/workspace";
import { TrayPage } from "@/pages/tray";
import { initializeLocale, useLocale } from "@/shared/lib/i18n";
import { initializeTheme, useTheme } from "@/shared/lib/theme";
import { useEffect, useLayoutEffect, ViewTransition } from "react";
import { initializeScrollEffects } from "./lib/scroll-effects";
void initializeLocale();
void initializeTheme();
export function App() {
  useEffect(initializeScrollEffects, []);
  const { ready: localeReady, language } = useLocale();
  const { ready: themeReady, theme } = useTheme();
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
  }, [language, theme]);
  if (!localeReady || !themeReady) return null;
  return (
    <ViewTransition
      update={{ language: "appearance", theme: "appearance", default: "page" }}
    >
      {location.hash === "#tray" ? <TrayPage /> : <WorkspacePage />}
    </ViewTransition>
  );
}
