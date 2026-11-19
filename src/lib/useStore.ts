import { useSyncExternalStore } from "react";
import { getState, subscribe } from "../data/store";
export function useStore() {
  return useSyncExternalStore(subscribe, getState, getState);
}
