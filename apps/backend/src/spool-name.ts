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
