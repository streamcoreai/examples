"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a media query without an effect, so the first client render
 * already knows the answer and nothing has to cascade to correct it. The server
 * snapshot is always false — there is no viewport to measure there.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query]
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}
