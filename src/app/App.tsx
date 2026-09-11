import { WorkspacePage } from "@/pages/workspace";
import { TrayPage } from "@/pages/tray";
export function App() {
  return location.hash === "#tray" ? <TrayPage /> : <WorkspacePage />;
}
