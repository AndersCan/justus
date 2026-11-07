export type Density = "comfortable" | "compact";

const STORAGE_KEY = "justus:gallery-density";

/** Tailwind grid-column classes for the gallery timeline at a given density. */
export function gridColsFor(density: Density): string {
  return density === "compact"
    ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7"
    : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
}

/** Read the persisted density preference. Falls back to "comfortable". */
export function readDensity(): Density {
  try {
    if (typeof localStorage === "undefined") return "comfortable";
    return localStorage.getItem(STORAGE_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

/** Persist the density preference (best-effort; no-op without storage). */
export function writeDensity(density: Density): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, density);
  } catch {
    // storage unavailable (private mode / non-browser) — ignore
  }
}
