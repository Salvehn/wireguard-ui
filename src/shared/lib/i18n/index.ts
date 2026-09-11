import { useSyncExternalStore } from "react";
import { animate } from "@/shared/lib/view-transition";
import english from "./en.json";

export type Language = "ru" | "en";
export type LanguagePreference = "system" | Language;
export type LocaleSettings = {
  preference: LanguagePreference;
  language: Language;
};
const dictionary: Record<string, string> = english;
let settings: LocaleSettings = {
  preference: "system",
  language: navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en",
};
let ready = false;
let snapshot = { ...settings, ready };
const listeners = new Set<() => void>();
const notify = () => {
  snapshot = { ...settings, ready };
  for (const listener of listeners) listener();
};
function apply(next: LocaleSettings) {
  const changed = next.language !== settings.language;
  if (ready && !changed && next.preference === settings.preference) return;
  const update = () => {
    settings = next;
    ready = true;
    document.documentElement.lang = next.language;
    notify();
  };
  if (ready && changed) animate(update, "language");
  else update();
}
export function useLocale() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
export function getLanguage() {
  return settings.language;
}
export async function setLanguage(preference: LanguagePreference) {
  apply(await window.wireguard.setLocale(preference));
}
export async function initializeLocale() {
  window.wireguard.onLocaleChange(apply);
  try {
    apply(await window.wireguard.getLocale());
  } catch {
    apply(settings);
  }
  const refresh = () => {
    void window.wireguard
      .getLocale()
      .then(apply)
      .catch(() => {});
  };
  window.addEventListener("languagechange", refresh);
  window.addEventListener("focus", refresh);
}
export function t(
  source: string,
  values: Record<string, string | number> = {},
) {
  const key = source.trim();
  const translated = settings.language === "en" ? dictionary[key] : undefined;
  const template =
    translated === undefined ? source : source.replace(key, translated);
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    String(values[name] ?? token),
  );
}
const templates = Object.keys(dictionary)
  .filter((key) => key.includes("{name}"))
  .map((key) => ({
    key,
    pattern: new RegExp(
      "^" +
        key
          .split("{name}")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("([\\s\\S]+)") +
        "$",
    ),
  }));
/** Translate app messages while preserving profile names and raw backend diagnostics. */
export function message(source: string) {
  const clean = source.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
  if (settings.language === "ru") return clean;
  if (dictionary[clean]) return t(clean);
  for (const { key, pattern } of templates) {
    const match = clean.match(pattern);
    if (match) return t(key, { name: match[1] });
  }
  return clean;
}
