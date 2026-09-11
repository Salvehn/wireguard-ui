import { WorkspacePage } from "@/pages/workspace";
import { TrayPage } from "@/pages/tray";
import { initializeLocale, useLocale } from "@/shared/lib/i18n";
void initializeLocale();
export function App() {
  const { ready } = useLocale();
  if (!ready) return null;
  return location.hash === "#tray" ? <TrayPage /> : <WorkspacePage />;
}
