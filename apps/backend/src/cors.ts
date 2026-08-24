/**
 * Origin policy for the justus loopback HTTP surface.
 *
 * The worklet serves both the web app shell and the photo bytes on a loopback
 * address (127.0.0.1). The browser UI talks to it same-origin — the WebView
 * loads the app from the loopback server itself — so any request whose `Origin`
 * is a loopback host is first-party. Anything else is a cross-origin caller (a
 * malicious site the user visited, an XSS payload, a navigate-to link) and must
 * neither be able to drive side effects nor read the JSON response back.
 *
 * This replaces the previous `Access-Control-Allow-Origin: *`, which let any
 * website read photo/gallery/upload responses cross-origin whenever the session
 * was present (issue #69), and pairs with the on-device `isAuthorized` gate that
 * already protects `POST /photos` when auth is enabled (issue #67).
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // RFC 6761: `*.localhost` resolves to loopback.
  return h.endsWith(".localhost");
}

function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

export type OriginVerdict = {
  /** Whether the request may proceed (no Origin, or a loopback Origin). */
  allowed: boolean;
  /**
   * Value for the `Access-Control-Allow-Origin` response header, or
   * `undefined` to omit it. We only ever reflect a loopback Origin — never
   * `*` — so a remote site cannot read the response cross-origin.
   */
  corsOrigin: string | undefined;
};

export function classifyOrigin(originHeader: string | string[] | undefined): OriginVerdict {
  const raw = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!raw) {
    // No Origin header: a non-browser client, a same-origin navigation, or a
    // server-to-server call. There is no cross-origin read to defend against.
    return { allowed: true, corsOrigin: undefined };
  }
  const host = originHost(raw);
  if (host && isLoopbackHost(host)) {
    return { allowed: true, corsOrigin: raw };
  }
  // Cross-origin browser request: reject and withhold CORS so the response is
  // neither applied nor readable off the loopback.
  return { allowed: false, corsOrigin: undefined };
}
