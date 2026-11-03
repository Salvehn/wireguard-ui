import { tunnelApi, type Profile, type State } from "@/entities/tunnel";

export async function toggleTunnel(
  profile: Profile,
  state: State,
  api = tunnelApi,
): Promise<State> {
  if (!state.backend) {
    let currentState = await api.setupHelper();
    if (currentState.helper.status !== "ready") return currentState;
    let current = currentState.profiles.find((p) => p.id === profile.id);
    if (current?.statusUnknown) {
      currentState = await api.refreshStats();
      current = currentState.profiles.find((p) => p.id === profile.id);
    }
    // Permission/setup is an intent to connect. Installation may have stopped
    // an old tunnel, so do not toggle the stale pre-installation profile.
    if (
      currentState.helper.status !== "ready" ||
      !current ||
      current.statusUnknown ||
      current.active
    )
      return currentState;
    return api.setActive(current.id, true);
  }
  return profile.statusUnknown
    ? api.refreshStats()
    : api.setActive(profile.id, !profile.active);
}
