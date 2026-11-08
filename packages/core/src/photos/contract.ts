/**
 * The runtime contract for every payload that crosses the backend -> web
 * boundary. The schemas below are the single source of truth for validation;
 * `types.ts` keeps the documented TS types, and the `Equal` assertions at the
 * bottom fail `tsc` if a type and its schema ever diverge.
 *
 * Hand-written on purpose: a small schema helper beats a new dependency in a
 * Bare worklet. Unknown extra keys are allowed (forward compatible); a missing
 * or mistyped field is an error that names its path.
 */
import type {
  AskSummary,
  DeletedAlbum,
  FolderSummary,
  JoinRequest,
  Photo,
  PhotoChanged,
  PhotoHolders,
  PhotoMember,
  SyncMember,
  SyncStatus,
} from "./types";

export interface Schema<T> {
  /** Returns a message naming the first offending path, or null when valid. */
  check(value: unknown, path: string): string | null;
  readonly _t?: T;
}
export interface OptionalSchema<T> {
  readonly optional: true;
  readonly inner: Schema<T>;
}

const describe = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const prim = <T>(type: string, ok: (v: unknown) => boolean): Schema<T> => ({
  check: (v, path) => (ok(v) ? null : `${path}: expected ${type}, got ${describe(v)}`),
});

type Flat<T> = { [K in keyof T]: T[K] };
type ReqKeys<S> = { [K in keyof S]: S[K] extends OptionalSchema<any> ? never : K }[keyof S];
type OptKeys<S> = { [K in keyof S]: S[K] extends OptionalSchema<any> ? K : never }[keyof S];
type Val<F> = F extends Schema<infer T> ? T : F extends OptionalSchema<infer T> ? T : never;
export type Infer<S> = Flat<{ [K in ReqKeys<S>]: Val<S[K]> } & { [K in OptKeys<S>]?: Val<S[K]> }>;

export const s = {
  string: prim<string>("string", (v) => typeof v === "string"),
  number: prim<number>("number", (v) => typeof v === "number" && Number.isFinite(v)),
  boolean: prim<boolean>("boolean", (v) => typeof v === "boolean"),
  oneOf<const L extends readonly string[]>(...values: L): Schema<L[number]> {
    return {
      check: (v, path) =>
        typeof v === "string" && values.includes(v)
          ? null
          : `${path}: expected one of ${values.join("|")}, got ${JSON.stringify(v)}`,
    };
  },
  array<T>(item: Schema<T>): Schema<T[]> {
    return {
      check(v, path) {
        if (!Array.isArray(v)) return `${path}: expected array, got ${describe(v)}`;
        for (let i = 0; i < v.length; i++) {
          const e = item.check(v[i], `${path}[${i}]`);
          if (e) return e;
        }
        return null;
      },
    };
  },
  optional<T>(inner: Schema<T>): OptionalSchema<T> {
    return { optional: true, inner };
  },
  object<const S extends Record<string, Schema<any> | OptionalSchema<any>>>(
    shape: S,
  ): Schema<Infer<S>> {
    return {
      check(v, path) {
        if (typeof v !== "object" || v === null || Array.isArray(v))
          return `${path}: expected object, got ${describe(v)}`;
        const rec = v as Record<string, unknown>;
        for (const [key, field] of Object.entries(shape)) {
          const sub = `${path}.${key}`;
          if ("optional" in field) {
            if (rec[key] === undefined) continue;
            const e = field.inner.check(rec[key], sub);
            if (e) return e;
          } else {
            if (rec[key] === undefined) return `${sub}: missing required field`;
            const e = field.check(rec[key], sub);
            if (e) return e;
          }
        }
        return null;
      },
    };
  },
};

export const photoMemberSchema = s.object({ key: s.string, name: s.string });

export const photoHoldersSchema = s.object({
  here: s.boolean,
  others: s.array(photoMemberSchema),
  unsure: s.array(photoMemberSchema),
  waiting: s.array(photoMemberSchema),
  former: s.array(s.string),
});

export const photoSchema = s.object({
  id: s.string,
  url: s.string,
  thumbUrl: s.optional(s.string),
  name: s.string,
  mime: s.string,
  size: s.number,
  addedAt: s.number,
  takenAt: s.optional(s.string),
  member: photoMemberSchema,
  sha256: s.optional(s.string),
  folderId: s.optional(s.string),
  mine: s.optional(s.boolean),
  holders: s.optional(photoHoldersSchema),
});

export const syncMemberSchema = s.object({
  key: s.string,
  name: s.string,
  admin: s.boolean,
  connected: s.boolean,
  lastSeenAt: s.optional(s.number),
  identity: s.optional(s.string),
  viewer: s.optional(s.boolean),
});

export const folderSummarySchema = s.object({
  id: s.string,
  name: s.string,
  role: s.oneOf("creator", "member", "reader"),
  pending: s.optional(s.boolean),
  shareKey: s.string,
  driveKey: s.string,
  members: s.number,
  addedAt: s.number,
  invite: s.optional(s.object({ code: s.string, owner: s.string })),
  notice: s.optional(
    s.object({ kind: s.oneOf("newKey", "moved", "removed"), ownerName: s.optional(s.string) }),
  ),
  waitingFor: s.optional(s.array(s.string)),
});

export const askSummarySchema = s.object({
  code: s.string,
  owner: s.string,
  albumName: s.string,
  ownerName: s.string,
  askedAt: s.number,
  status: s.oneOf("waiting", "declined", "linkOff"),
  checkCode: s.optional(s.string),
});

export const offerSummarySchema = s.object({
  code: s.string,
  owner: s.string,
  albumName: s.string,
  ownerName: s.string,
});

export const deletedAlbumSchema = s.object({
  id: s.string,
  name: s.string,
  adminName: s.string,
});

export const syncStatusSchema = s.object({
  folder: folderSummarySchema,
  name: s.string,
  driveKey: s.string,
  discoveryKey: s.string,
  peers: s.number,
  photos: s.number,
  members: s.array(syncMemberSchema),
  updateNeeded: s.boolean,
  peersBehind: s.array(s.string),
});

export const joinRequestSchema = s.object({
  requesterKey: s.string,
  requesterName: s.string,
  folderId: s.string,
  folderName: s.string,
  shareKey: s.string,
  requestedAt: s.number,
  viaInvite: s.optional(s.boolean),
  checkCode: s.optional(s.string),
  requesterIdentity: s.optional(s.string),
});

export const photoChangedSchema = s.object({
  cause: s.oneOf(
    "add",
    "remove",
    "enroll",
    "request",
    "presence",
    "ask",
    "offer",
    "version",
    "holders",
  ),
  folderId: s.optional(s.string),
  memberKey: s.optional(s.string),
  code: s.optional(s.string),
  answer: s.optional(s.oneOf("accepted", "declined", "linkOff")),
});

/** Result schema of every `photos.*` invoke the web reads, by event name. */
export const photoResultSchemas = {
  "photos.list": s.object({ photos: s.array(photoSchema) }),
  "photos.add": photoSchema,
  "photos.remove": s.object({ id: s.string }),
  "photos.join": syncStatusSchema,
  "photos.enroll": syncStatusSchema,
  "photos.status": syncStatusSchema,
  "photos.folders": s.object({
    folders: s.array(folderSummarySchema),
    archived: s.array(folderSummarySchema),
    deleted: s.array(deletedAlbumSchema),
    activeFolderId: s.string,
    asks: s.array(askSummarySchema),
    offers: s.array(offerSummarySchema),
  }),
  "photos.ask": s.object({ ask: askSummarySchema }),
  "photos.createFolder": s.object({ folder: folderSummarySchema }),
  "photos.setActive": syncStatusSchema,
  "photos.setName": s.object({ name: s.string }),
  "photos.requests": s.object({ requests: s.array(joinRequestSchema) }),
  "photos.makeMember": s.object({ ok: s.boolean }),
  "photos.makeViewer": s.object({ ok: s.boolean }),
  "photos.removeMember": s.object({ ok: s.boolean }),
  "photos.respond": s.object({ ok: s.boolean }),
  "photos.offerAlbum": s.object({ ok: s.boolean, waiting: s.optional(s.boolean) }),
  "photos.joinOffer": s.object({ ask: askSummarySchema }),
  "photos.archiveAlbum": s.object({ ok: s.boolean }),
  "photos.restoreAlbum": s.object({ ok: s.boolean }),
  "photos.deleteAlbum": s.object({ ok: s.boolean }),
  "photos.leaveAlbum": s.object({ ok: s.boolean }),
  "photos.dismissAlbumNotice": s.object({ ok: s.boolean }),
  "photos.dismissDeclinedAsk": s.object({ ok: s.boolean }),
  "photos.cancelAsk": s.object({ ok: s.boolean }),
  "photos.turnOffInvite": s.object({ invite: s.object({ code: s.string, owner: s.string }) }),
  "photos.saveInviteLink": s.object({ ok: s.boolean }),
} as const;

/** Validates an invoke result; returns a message naming the field, or null. */
export function checkPhotoResult(name: string, value: unknown): string | null {
  const schema = (photoResultSchemas as Record<string, Schema<unknown>>)[name];
  if (!schema) return null;
  const e = schema.check(value, "result");
  return e ? `${name} contract violation: ${e}` : null;
}

/** Validates a `photos.changed` push payload. */
export function checkPhotoChanged(value: unknown): string | null {
  const e = photoChangedSchema.check(value, "args");
  return e ? `photos.changed contract violation: ${e}` : null;
}

// Compile-time: each documented TS type must equal its schema's inferred type.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type T<S> = S extends Schema<infer X> ? X : never;
export type _ContractChecks = [
  Assert<Equal<T<typeof photoMemberSchema>, PhotoMember>>,
  Assert<Equal<T<typeof photoHoldersSchema>, PhotoHolders>>,
  Assert<Equal<T<typeof photoSchema>, Photo>>,
  Assert<Equal<T<typeof syncMemberSchema>, SyncMember>>,
  Assert<Equal<T<typeof folderSummarySchema>, FolderSummary>>,
  Assert<Equal<T<typeof askSummarySchema>, AskSummary>>,
  Assert<Equal<T<typeof deletedAlbumSchema>, DeletedAlbum>>,
  Assert<Equal<T<typeof syncStatusSchema>, SyncStatus>>,
  Assert<Equal<T<typeof joinRequestSchema>, JoinRequest>>,
  Assert<Equal<T<typeof photoChangedSchema>, PhotoChanged>>,
];
