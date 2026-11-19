import { peerName, type RegistryFile, type ViewersFile } from "./records";

/** One person on the Admin's two lists, as this phone read them. */
export type ListedPerson = { key: string; name: string; addedAt: number };

/** Someone this phone says joined, until dismissed. */
export type JoinedPerson = { key: string; name: string };

export type WhoJoined = { joinedUpTo?: number; whoJoined?: JoinedPerson[] };

/** Names shown while a phone's real name is not known yet. */
const NOT_NAMED: ReadonlySet<string> = new Set(["", "Unknown device", "New member"]);

function stamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Collaborators then Viewers not also Collaborators; a missing or non-number addedAt reads as 0. */
export function listedPeople(
  registry: RegistryFile,
  viewers: ViewersFile["viewers"],
): ListedPerson[] {
  const seen = new Set<string>();
  const out: ListedPerson[] = [];
  for (const person of [...Object.values(registry.members), ...Object.values(viewers)]) {
    if (seen.has(person.key)) continue;
    seen.add(person.key);
    out.push({ key: person.key, name: person.name, addedAt: stamp(person.addedAt) });
  }
  return out;
}

/** Who this phone now says joined after it. `undefined` = nothing changes. Inputs are not changed. */
export function nextWhoJoined(
  now: WhoJoined,
  read: { selfKey: string; adminKey: string; people: readonly ListedPerson[] },
): WhoJoined | undefined {
  const self = read.people.find((person) => person.key === read.selfKey);
  if (self === undefined) return undefined;
  if (now.joinedUpTo === undefined) {
    let top = 0;
    for (const person of read.people) top = Math.max(top, person.addedAt);
    return { joinedUpTo: top };
  }
  const floor = Math.max(self.addedAt, now.joinedUpTo);
  const later: ListedPerson[] = [];
  for (const person of read.people) {
    const isOther = person.key !== read.selfKey && person.key !== read.adminKey;
    if (isOther && person.addedAt > floor) later.push(person);
  }
  later.sort((a, b) => a.addedAt - b.addedAt || (a.key < b.key ? -1 : 1));
  const newest = later[later.length - 1];
  if (newest === undefined) return undefined;
  const names = [...(now.whoJoined ?? [])];
  for (const person of later) {
    const name = peerName(person.name, "");
    if (NOT_NAMED.has(name) || names.some((known) => known.key === person.key)) continue;
    names.push({ key: person.key, name });
  }
  return {
    joinedUpTo: newest.addedAt,
    ...(names.length > 0 ? { whoJoined: names } : {}),
  };
}
