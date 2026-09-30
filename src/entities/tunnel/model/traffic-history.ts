import type { Profile } from "./types";

export const trafficWindow = 60_000;
export const trafficGap = 10_000;
export type TrafficSample = {
  start: number;
  time: number;
  rx: number;
  tx: number;
};
type Counters = {
  time: number;
  iface: string | null;
  peers: Map<string, { rx: number; tx: number }>;
};
type History = {
  previous: Counters | null;
  samples: TrafficSample[];
  available: boolean;
  latest: number;
  scale: number;
};

export function createTrafficHistory() {
  const histories = new Map<string, History>();
  return {
    record(profiles: Profile[]) {
      const ids = new Set(profiles.map((profile) => profile.id));
      for (const id of histories.keys()) if (!ids.has(id)) histories.delete(id);
      for (const profile of profiles) {
        let history = histories.get(profile.id);
        if (!history) {
          history = {
            previous: null,
            samples: [],
            available: false,
            latest: 0,
            scale: 1024,
          };
          histories.set(profile.id, history);
        }
        const stats = profile.stats;
        if (!profile.active || profile.statusUnknown || !stats) {
          history.previous = null;
          history.available = false;
          continue;
        }
        if (!Number.isFinite(stats.updatedAt) || stats.updatedAt <= 0) {
          history.previous = null;
          history.available = false;
          continue;
        }
        // Repeated cached snapshots must neither add samples nor change the baseline.
        if (stats.updatedAt <= history.latest) continue;
        const next: Counters = {
          time: stats.updatedAt,
          iface: profile.interfaceName,
          peers: new Map(
            stats.peers.map((peer) => [
              peer.publicKey,
              { rx: peer.rx, tx: peer.tx },
            ]),
          ),
        };
        const previous = history.previous;
        history.previous = next;
        history.latest = next.time;
        history.available = true;
        history.samples = history.samples.filter(
          (sample) => sample.time > next.time - trafficWindow,
        );
        let rx = 0,
          tx = 0;
        const elapsed = previous ? next.time - previous.time : 0;
        let valid =
          !!previous &&
          elapsed > 0 &&
          elapsed <= trafficGap &&
          previous.iface === next.iface &&
          previous.peers.size === next.peers.size;
        for (const [key, peer] of next.peers) {
          const old = previous?.peers.get(key);
          if (
            !old ||
            !Number.isFinite(peer.rx) ||
            !Number.isFinite(peer.tx) ||
            !Number.isFinite(old.rx) ||
            !Number.isFinite(old.tx) ||
            peer.rx < 0 ||
            peer.tx < 0 ||
            peer.rx < old.rx ||
            peer.tx < old.tx
          ) {
            valid = false;
            break;
          }
          rx += peer.rx - old.rx;
          tx += peer.tx - old.tx;
        }
        if (!valid || !previous) continue;
        history.samples.push({
          start: previous.time,
          time: next.time,
          rx: (rx * 1000) / elapsed,
          tx: (tx * 1000) / elapsed,
        });
        history.samples = history.samples.slice(-240);
        const peak = Math.max(
          1024,
          ...history.samples.flatMap((sample) => [sample.rx, sample.tx]),
        );
        const target = 2 ** Math.ceil(Math.log2(peak * 1.15));
        // Expand to contain real peaks; contract gently as old peaks leave the window.
        history.scale =
          target >= history.scale
            ? target
            : Math.max(target, history.scale * Math.exp(-elapsed / 15_000));
      }
    },
    read(id: string, now: number) {
      const history = histories.get(id);
      const samples =
        history?.samples.filter(
          (sample) => sample.time > now - trafficWindow,
        ) || [];
      const last = samples.at(-1);
      const current =
        history?.available &&
        last?.time === history.latest &&
        now - history.latest <= trafficGap
          ? last
          : null;
      return { samples, current, scale: history?.scale || 1024 };
    },
  };
}

export const trafficHistory = createTrafficHistory();
