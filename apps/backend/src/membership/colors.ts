import type { RegistryFile, ViewersFile } from "./records";

/** The Admin's seat in the album's palette. It is never stored; it comes from being the Admin. */
export const ADMIN_COLOR = 0;

const MAX_COLOR = 999;

/** A stored colour seat: an integer from 1 to 999. Anything else reads as absent. */
export function parseColor(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_COLOR
    ? value
    : undefined;
}

/** `preferred` when it is free, else the lowest seat from 1 that is not taken. */
export function pickColor(taken: ReadonlySet<number>, preferred?: number): number {
  if (preferred !== undefined && !taken.has(preferred)) return preferred;
  let seat = 1;
  while (taken.has(seat)) seat += 1;
  return seat;
}

/** The Admin's seat plus every seat the two lists hold. */
export function takenColors(registry: RegistryFile, viewers: ViewersFile["viewers"]): Set<number> {
  const taken = new Set<number>([ADMIN_COLOR]);
  for (const entry of [...Object.values(registry.members), ...Object.values(viewers)]) {
    if (entry.color !== undefined) taken.add(entry.color);
  }
  return taken;
}

/** Gives a seat to every entry that has none: oldest first (ties by key), members before
 * viewers. Entries that have one are untouched. `changed` says which file needs writing. */
export function fillColors(
  registry: RegistryFile,
  viewers: ViewersFile,
): {
  registry: RegistryFile;
  viewers: ViewersFile;
  membersChanged: boolean;
  viewersChanged: boolean;
} {
  const taken = takenColors(registry, viewers.viewers);
  const oldestFirst = <T extends { key: string; addedAt: number }>(entries: T[]) =>
    entries.sort((a, b) => a.addedAt - b.addedAt || (a.key < b.key ? -1 : 1));
  const members = { ...registry.members };
  const viewerEntries = { ...viewers.viewers };
  let membersChanged = false;
  let viewersChanged = false;
  for (const m of oldestFirst(Object.values(registry.members))) {
    if (m.color !== undefined) continue;
    const color = pickColor(taken);
    taken.add(color);
    members[m.key] = { ...m, color };
    membersChanged = true;
  }
  for (const v of oldestFirst(Object.values(viewers.viewers))) {
    if (v.color !== undefined) continue;
    const color = pickColor(taken);
    taken.add(color);
    viewerEntries[v.key] = { ...v, color };
    viewersChanged = true;
  }
  return {
    registry: { ...registry, members },
    viewers: { ...viewers, viewers: viewerEntries },
    membersChanged,
    viewersChanged,
  };
}
