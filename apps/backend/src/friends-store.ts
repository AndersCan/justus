import { CoreError, err, ok } from "@ekrooh/bare/core";
import { FRIEND_NAME_MAX, FriendError, type Friend } from "@justus/core";
import { isHexKey } from "./membership/records";
import type { Files, Paths } from "./ports/files";

type FriendsStoreOpts = { dir: string; files: Files; paths: Paths };

export type FriendsStore = {
  list(): [null, Friend[]] | [CoreError, null];
  add(identity: string, name: string): Promise<[null, Friend] | [CoreError, null]>;
  rename(identity: string, name: string): Promise<[null, Friend] | [CoreError, null]>;
  remove(identity: string): Promise<[null, { removed: boolean }] | [CoreError, null]>;
};

function readFriends(files: Files, file: string): Map<string, string> {
  const friends = new Map<string, string>();
  let text: string;
  try {
    if (!files.existsSync(file)) return friends;
    text = files.readFileSync(file, "utf8") as string;
  } catch (e) {
    console.error(`[justus] friends.json unreadable: ${String(e)}`);
    return friends;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error(`[justus] friends.json is not JSON: ${String(e)}`);
    return friends;
  }
  const entries =
    typeof parsed === "object" && parsed !== null && "friends" in parsed ? parsed.friends : null;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    console.error("[justus] friends.json has an unexpected shape");
    return friends;
  }
  for (const [identity, entry] of Object.entries(entries)) {
    if (!isHexKey(identity)) continue;
    if (typeof entry !== "object" || entry === null || !("name" in entry)) continue;
    if (typeof entry.name !== "string" || entry.name.trim() === "") continue;
    friends.set(identity.toLowerCase(), entry.name);
  }
  return friends;
}

/** The friends file in `dir`: `{ version: 1, friends: { <identity>: { name } } }`.
 * Read once on first use, then served from memory. Writes go to a temp file and
 * are renamed over the real one, so a crash keeps the old file. */
export function createFriendsStore(opts: FriendsStoreOpts): FriendsStore {
  const { files, paths } = opts;
  const file = paths.join(opts.dir, "friends.json");
  let cache: Map<string, string> | null = null;

  function load(): Map<string, string> {
    cache ??= readFriends(files, file);
    return cache;
  }

  function write(friends: Map<string, string>): void {
    const body = {
      version: 1,
      friends: Object.fromEntries([...friends].map(([identity, name]) => [identity, { name }])),
    };
    const tmp = `${file}.tmp`;
    files.mkdirSync(opts.dir, { recursive: true });
    files.writeFileSync(tmp, JSON.stringify(body));
    files.renameSync(tmp, file);
  }

  return {
    list() {
      return ok([...load()].map(([identity, name]) => ({ identity, name })));
    },
    async add(identity, name) {
      if (!isHexKey(identity)) {
        return err(FriendError.INVALID_KEY, "identity must be 64 hex characters");
      }
      const key = identity.toLowerCase();
      const friends = load();
      const existing = friends.get(key);
      if (existing !== undefined) return ok({ identity: key, name: existing });
      const trimmed = name.trim().slice(0, FRIEND_NAME_MAX);
      if (trimmed === "") return err(FriendError.NAME_REQUIRED, "name is required");
      const next = new Map(friends).set(key, trimmed);
      try {
        write(next);
      } catch (e) {
        return err(FriendError.WRITE_FAILED, `could not save friends: ${String(e)}`);
      }
      cache = next;
      return ok({ identity: key, name: trimmed });
    },
    async rename(identity, name) {
      if (!isHexKey(identity)) {
        return err(FriendError.INVALID_KEY, "identity must be 64 hex characters");
      }
      const key = identity.toLowerCase();
      const trimmed = name.trim().slice(0, FRIEND_NAME_MAX).trim();
      if (trimmed === "") return err(FriendError.NAME_REQUIRED, "name is required");
      const friends = load();
      if (!friends.has(key)) return err(FriendError.NOT_FOUND, "that person is not saved");
      const next = new Map(friends).set(key, trimmed);
      try {
        write(next);
      } catch (e) {
        return err(FriendError.WRITE_FAILED, `could not save friends: ${String(e)}`);
      }
      cache = next;
      return ok({ identity: key, name: trimmed });
    },
    async remove(identity) {
      if (!isHexKey(identity)) {
        return err(FriendError.INVALID_KEY, "identity must be 64 hex characters");
      }
      const key = identity.toLowerCase();
      const friends = load();
      if (!friends.has(key)) return ok({ removed: false });
      const next = new Map(friends);
      next.delete(key);
      try {
        write(next);
      } catch (e) {
        return err(FriendError.WRITE_FAILED, `could not save friends: ${String(e)}`);
      }
      cache = next;
      return ok({ removed: true });
    },
  };
}
