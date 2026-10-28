export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "justus:theme";

export function readTheme(): Theme {
  try {
    const value = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Persist (best-effort) and apply the theme to <html data-theme>. "system"
 * removes the attribute so `prefers-color-scheme` decides. */
export function writeTheme(theme: Theme): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (theme === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    // storage unavailable — the choice just won't persist
  }
  if (typeof document === "undefined") return;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
