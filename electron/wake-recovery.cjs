// A quiet peer without keepalive is not evidence of a broken connection.
function connectionHealth(profile, now = Date.now()) {
  if (!profile.active || profile.statusUnknown || profile.appRouting)
    return "unknown";
  const peers = profile.stats?.peers || [];
  if (peers.some((p) => !p.lastHandshake && p.rx === 0)) return "waiting";
  if (
    peers.some(
      (p) =>
        Number(p.keepalive) > 0 &&
        p.lastHandshake > 0 &&
        now / 1000 - p.lastHandshake > 180,
    )
  )
    return "stale";
  return "unknown";
}
function stalledAfterWake(profile, baseline, resumedAt) {
  if (
    !profile.active ||
    profile.statusUnknown ||
    profile.appRouting ||
    !profile.stats
  )
    return false;
  // Never restart a newly created interface or a tunnel whose counters reset.
  if (profile.interfaceName !== baseline.interfaceName) return false;
  const peers = profile.stats.peers;
  return (
    peers.length > 0 &&
    peers.every((peer) => {
      const before = baseline.stats?.peers.find(
        (p) => p.publicKey === peer.publicKey,
      );
      return (
        before &&
        peer.lastHandshake < resumedAt / 1000 &&
        peer.rx === before.rx &&
        peer.tx >= before.tx
      );
    }) &&
    peers.some((peer) => {
      const before = baseline.stats.peers.find(
        (p) => p.publicKey === peer.publicKey,
      );
      return peer.tx > before.tx;
    })
  );
}
function createWakeRecovery({
  controller,
  snapshot,
  refresh,
  log,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  delay = 35000,
}) {
  let generation = 0,
    timer;
  function stop() {
    generation++;
    cancel(timer);
    timer = undefined;
  }
  return {
    stop,
    resume() {
      stop();
      const token = generation,
        resumedAt = now();
      const candidates = snapshot()
        .filter((p) => p.active && !p.statusUnknown && !p.appRouting && p.stats)
        .map((p) => ({ baseline: p, revision: controller.revision(p.id) }));
      timer = schedule(async () => {
        try {
          await refresh();
          for (const { baseline, revision } of candidates) {
            if (token !== generation) return;
            await controller.reconnect(baseline.id, {
              revision,
              cancelled: () => token !== generation,
              shouldReconnect: (p) => stalledAfterWake(p, baseline, resumedAt),
            });
          }
        } catch (error) {
          log(error.message);
        }
      }, delay);
      timer?.unref?.();
    },
  };
}
module.exports = { createWakeRecovery, stalledAfterWake, connectionHealth };
