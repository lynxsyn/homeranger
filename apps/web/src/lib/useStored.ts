/**
 * useStored — a `useState` that persists to localStorage under `key`,
 * initialising from the stored value when present. Used for the theme
 * (`hs-theme`) and the listings view toggle (`hs-view`); the same `hs-theme`
 * key is read pre-paint by the inline script in index.html.
 *
 * Pass `accepts` (the closed set of valid values) so a stray/stale localStorage
 * string — a manual edit, an extension, or a future rename — falls back to
 * `fallback` instead of being trusted (an invalid `hs-view`, say, would leave
 * the page rendering neither the table nor the cards).
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useCallback, useState } from "react";

export function useStored<T extends string>(
  key: string,
  fallback: T,
  accepts?: readonly T[],
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored != null && (!accepts || accepts.includes(stored as T))) {
        return stored as T;
      }
    } catch {
      // localStorage unavailable (private mode / SSR) — fall back.
    }
    return fallback;
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Best-effort persistence; ignore quota/availability errors.
      }
    },
    [key],
  );

  return [value, set];
}
