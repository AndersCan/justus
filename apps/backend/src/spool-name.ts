/**
 * Filesystem- and URL-safe spool name for a derived gallery photo.
 *
 * The inputs (driveKey, id, ext) partially originate from *untrusted* drive
 * photo keys: any folder member can publish a file under `/photos` whose
 * parsed `id`/`ext` contain path separators or `".."` segments. Building a
 * spool path by interpolating that `id`/`ext` directly lets a malicious member
 * write attacker-controlled bytes to an arbitrary path on the host
 * (issue #71). Encoding the tuple as URL-safe base64 yields a fixed-shape
 * token with no separators, so joining it under the spool directory can never
 * escape that directory.
 *
 * Kept free of `bare-*` imports on purpose: this module must load and be
 * unit-tested under Node without the Bare global shim.
 */
export function spoolNameFor(driveKey: string, id: string, ext: string): string {
  const raw = `${driveKey}:${id}:${ext}`;
  // base64 then normalize to URL-safe (replace +/ with -_, drop padding) so
  // the token is safe both as a filename and inside a mounted URL route.
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Reverses `spoolNameFor`. Reads the token before the first `.`, so a `.tmp` leftover parses too. `undefined` for any other name. */
export function parseSpoolName(
  name: string,
): { driveKey: string; id: string; ext: string } | undefined {
  const token = name.split(".")[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const raw = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const first = raw.indexOf(":");
  if (first <= 0) return undefined;
  const driveKey = raw.slice(0, first);
  const rest = raw.slice(first + 1);
  const second = rest.indexOf(":");
  if (second < 0) return undefined;
  const id = rest.slice(0, second);
  const ext = rest.slice(second + 1);
  if (spoolNameFor(driveKey, id, ext) !== token) return undefined;
  return { driveKey, id, ext };
}
