import { WorkspacePage } from "@/pages/workspace";
import { TrayPage } from "@/pages/tray";
import { initializeLocale, useLocale } from "@/shared/lib/i18n";
import { initializeTheme, useTheme } from "@/shared/lib/theme";
import { useEffect } from "react";
import { initializeScrollEffects } from "./lib/scroll-effects";
void initializeLocale();
void initializeTheme();
export function App() {
  useEffect(initializeScrollEffects, []);
  const { ready: localeReady } = useLocale();
  const { ready: themeReady } = useTheme();
  if (!localeReady || !themeReady) return null;
  return location.hash === "#tray" ? <TrayPage /> : <WorkspacePage />;
}
