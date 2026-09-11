import { useSyncExternalStore } from "react";
import type { UpdateState } from "@/shared/lib/update";

let snapshot: UpdateState = {
  status: "idle",
  currentVersion: "",
  availableVersion: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: "",
  supported: false,
};
let initialized = false;
const listeners = new Set<() => void>();

function apply(state: UpdateState) {
  snapshot = state;
  for (const listener of listeners) listener();
  return state;
}

function initialize() {
  if (initialized) return;
  initialized = true;
  window.wireguard.onUpdateState(apply);
  void window.wireguard.getUpdateState().then(apply);
}

export function useAppUpdate() {
  initialize();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export const checkForUpdates = () =>
  window.wireguard.checkForUpdates().then(apply);
export const downloadUpdate = () =>
  window.wireguard.downloadUpdate().then(apply);
export const installUpdate = () => window.wireguard.installUpdate().then(apply);
