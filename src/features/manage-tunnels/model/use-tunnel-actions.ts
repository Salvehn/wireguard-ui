import { useState } from "react";
import { tunnelApi, type State } from "@/entities/tunnel";
export function useTunnelActions(
  accept: (state: State) => void,
  onError: (message: string) => void,
) {
  const [pending, setPending] = useState<string[]>([]);
  async function perform(fn: () => Promise<State>, id = "import") {
    setPending((p) => [...p, id]);
    onError("");
    try {
      accept(await fn());
    } catch (e) {
      onError((e as Error).message);
      try {
        accept(await tunnelApi.state());
      } catch {
        /* Keep the original action error. */
      }
    } finally {
      setPending((p) => p.filter((item) => item !== id));
    }
  }
  return { pending, perform };
}
