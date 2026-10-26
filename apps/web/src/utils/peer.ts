/** Dev-only peer selection: with `JUSTUS_PEERS=N pnpm run dev` the backend runs
 * N worklets on ports 8080+i. A tab picks one with `?peer=i`, remembered per
 * tab in sessionStorage so reloads and in-app navigation keep the same peer.
 * On-device and in production builds this is always peer 0 / same-origin. */
const KEY = "justus:dev-peer";
const BASE_PORT = 8080;

export function devPeer(): number {
  if (!import.meta.env.DEV || typeof window === "undefined") return 0;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("peer");
    if (fromQuery !== null && /^\d+$/.test(fromQuery)) {
      sessionStorage.setItem(KEY, fromQuery);
      return Number(fromQuery);
    }
    const stored = sessionStorage.getItem(KEY);
    if (stored && /^\d+$/.test(stored)) return Number(stored);
  } catch {
    // storage unavailable — fall back to peer 0
  }
  return 0;
}

export const devPeerPort = (): number => BASE_PORT + devPeer();

/** Base URL of this tab's worklet in browser dev ("" = same-origin). */
export function workletBase(): string {
  const peer = devPeer();
  return import.meta.env.DEV && peer > 0 ? `http://127.0.0.1:${BASE_PORT + peer}` : "";
}
