import type { UpdateState } from "@/shared/lib/update";

export type SmartTunnelingSettings = {
  mode: "off" | "include" | "exclude";
  entries: string[];
};

export type Peer = {
  publicKey: string;
  endpoint: string;
  allowedIPs: string;
  lastHandshake: number;
  rx: number;
  tx: number;
  keepalive: string;
};
export type Stats = { updatedAt: number; listenPort: number; peers: Peer[] };
export type Profile = {
  id: string;
  name: string;
  address: string;
  dns: string;
  endpoint: string;
  allowedIPs: string;
  peers: number;
  smartTunneling?: SmartTunnelingSettings;
  active: boolean;
  statusUnknown: boolean;
  notes: string[];
  interfaceName: string | null;
  stats: Stats | null;
};
export type State = {
  profiles: Profile[];
  backend: string | null;
  operations: Record<string, string>;
  statsBusy: boolean;
  helper: {
    status: "required" | "installing" | "ready" | "error";
    message: string;
  };
  logs: { time: number; message: string }[];
};
declare global {
  interface Window {
    wireguard: {
      getLocale: () => Promise<{
        preference: "system" | "ru" | "en";
        language: "ru" | "en";
      }>;
      setLocale: (preference: "system" | "ru" | "en") => Promise<{
        preference: "system" | "ru" | "en";
        language: "ru" | "en";
      }>;
      onLocaleChange: (
        listener: (locale: {
          preference: "system" | "ru" | "en";
          language: "ru" | "en";
        }) => void,
      ) => () => void;
      getTheme: () => Promise<{
        preference: "system" | "light" | "dark";
        theme: "light" | "dark";
      }>;
      setTheme: (preference: "system" | "light" | "dark") => Promise<{
        preference: "system" | "light" | "dark";
        theme: "light" | "dark";
      }>;
      onThemeChange: (
        listener: (theme: {
          preference: "system" | "light" | "dark";
          theme: "light" | "dark";
        }) => void,
      ) => () => void;
      getUpdateState: () => Promise<UpdateState>;
      checkForUpdates: () => Promise<UpdateState>;
      downloadUpdate: () => Promise<UpdateState>;
      installUpdate: () => Promise<UpdateState>;
      onUpdateState: (listener: (state: UpdateState) => void) => () => void;
      readSmartTunneling: (
        id: string,
      ) => Promise<{ settings: SmartTunnelingSettings; revision: string }>;
      saveSmartTunneling: (
        id: string,
        settings: SmartTunnelingSettings,
        revision: string,
      ) => Promise<State>;
      readConfig: (id: string) => Promise<{ text: string; revision: string }>;
      saveConfig: (
        id: string,
        text: string,
        revision: string,
      ) => Promise<State>;
      openMain: () => Promise<void>;
      state: () => Promise<State>;
      setupHelper: () => Promise<State>;
      refreshStats: () => Promise<State>;
      import: () => Promise<State>;
      setActive: (id: string, active: boolean) => Promise<State>;
      remove: (id: string) => Promise<State>;
    };
  }
}
