// Keep measured counters in the main process, independent of renderer timers.
// Retain an extra baseline before the chart's 60-second visible window.
function createTrafficBuffer({
  now = Date.now,
  window = 70000,
  limit = 256,
} = {}) {
  let frames = [],
    sequence = 0;
  const prune = () => {
    frames = frames
      .filter((frame) => frame.time > now() - window)
      .slice(-limit);
  };
  return {
    record(snapshot) {
      const profiles = Object.entries(snapshot.profiles).map(
        ([id, profile]) => ({
          id,
          active: !!profile.active,
          statusUnknown: !!profile.statusUnknown,
          interfaceName: profile.interfaceName || null,
          stats: profile.stats
            ? {
                updatedAt: profile.stats.updatedAt,
                peers: profile.stats.peers.map(({ publicKey, rx, tx }) => ({
                  publicKey,
                  rx,
                  tx,
                })),
              }
            : null,
        }),
      );
      frames.push({ sequence: ++sequence, time: now(), profiles });
      prune();
    },
    unavailable(
      ids = frames.at(-1)?.profiles.map((profile) => profile.id) || [],
    ) {
      this.record({
        profiles: Object.fromEntries(
          ids.map((id) => [id, { statusUnknown: true }]),
        ),
      });
    },
    read() {
      prune();
      return frames;
    },
  };
}
module.exports = { createTrafficBuffer };
