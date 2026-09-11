import { useSyncExternalStore } from "react";
import { animate } from "@/shared/lib/view-transition";

export type Theme = "light" | "dark";
export type ThemePreference = "system" | Theme;
export type ThemeSettings = {
  preference: ThemePreference;
  theme: Theme;
};
const media = matchMedia("(prefers-color-scheme: light)");
let settings: ThemeSettings = {
  preference: "system",
  theme: media.matches ? "light" : "dark",
};
let ready = false;
let snapshot = { ...settings, ready };
const listeners = new Set<() => void>();
const notify = () => {
  snapshot = { ...settings, ready };
  for (const listener of listeners) listener();
};
function apply(next: ThemeSettings) {
  const changed = next.theme !== settings.theme;
  if (ready && !changed && next.preference === settings.preference) return;
  const update = () => {
    settings = next;
    ready = true;
    document.documentElement.dataset.theme = next.theme;
    notify();
  };
  if (ready && changed) animate(update, "theme");
  else update();
}
export function useTheme() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
export async function setTheme(preference: ThemePreference) {
  apply(await window.wireguard.setTheme(preference));
}
export async function initializeTheme() {
  window.wireguard.onThemeChange(apply);
  try {
    apply(await window.wireguard.getTheme());
  } catch {
    apply(settings);
  }
  const refresh = () => {
    void window.wireguard
      .getTheme()
      .then(apply)
      .catch(() => {});
  };
  media.addEventListener("change", refresh);
  window.addEventListener("focus", refresh);
}
