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
  logs: { time: string; message: string }[];
};
declare global {
  interface Window {
    wireguard: {
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
