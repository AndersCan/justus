import fs from "bare-fs";
import path from "bare-path";

/**
 * Dev-only watched inbox: a file dropped into `inboxDir` is imported as a
 * photo (dev loop stand-in for the native picker, which has no host in dev).
 * Polls to avoid bare-fs watcher quirks; never errors.
 */
export function createDevInbox(deps: { inboxDir: string; onFile: (filePath: string) => void }) {
  let closed = false;
  const seen = new Set<string>();

  const scan = () => {
    if (closed) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(deps.inboxDir);
    } catch {
      return; // dir missing
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(deps.inboxDir, name);
      if (seen.has(full)) continue;
      seen.add(full);
      // Wait for the copy that dropped the file to finish before importing.
      setTimeout(() => {
        if (!closed) deps.onFile(full);
      }, 250);
    }
  };

  const timer = setInterval(scan, 1500);
  scan();

  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
