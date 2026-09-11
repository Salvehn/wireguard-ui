import { useEffect, useState, useCallback, useRef } from "react";
import { tunnelApi } from "../api/tunnel-api";
import type { State } from "./types";
const initialState: State = {
  profiles: [],
  backend: null,
  operations: {},
  statsBusy: false,
  helper: { status: "required", message: "" },
  logs: [],
};
export function useTunnels(interval = 2500) {
  const [data, setData] = useState(initialState),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0);
  // Background snapshots update live DOM without capturing the whole window.
  const commit = useCallback((state: State) => {
    setData(state);
    setReady(true);
  }, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const state = await tunnelApi.state();
      if (request === sequence.current) {
        commit(state);
      }
    } catch (e) {
      if (request === sequence.current) setError((e as Error).message);
    }
  }, [commit]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, interval);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [interval, refresh]);
  const accept = useCallback(
    (state: State) => {
      sequence.current++;
      commit(state);
    },
    [commit],
  );
  return { data, setData: accept, ready, error, setError, refresh };
}
