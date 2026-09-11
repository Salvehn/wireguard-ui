import { WorkspacePage } from "@/pages/workspace";
import { TrayPage } from "@/pages/tray";
import { initializeLocale, useLocale } from "@/shared/lib/i18n";
import { initializeTheme, useTheme } from "@/shared/lib/theme";
void initializeLocale();
void initializeTheme();
export function App() {
  const { ready: localeReady } = useLocale();
  const { ready: themeReady } = useTheme();
  if (!localeReady || !themeReady) return null;
  return location.hash === "#tray" ? <TrayPage /> : <WorkspacePage />;
}
