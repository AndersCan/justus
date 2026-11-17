import { copy } from "../copy/copy";
import { friendsActor } from "../machines/friends-machine";
import { syncActor } from "../machines/sync-machine";
import { buildPeople, nameList } from "../utils/people";
import { toast } from "./toast";

export type DroppedIn = { folderId: string; people: { key: string; name: string }[] };

/** Each phone as the delete toast names it: the saved friend name, "Unknown device" for none. */
export function droppedNames(d: DroppedIn): string[] {
  const status = syncActor.snapshot().context.status;
  const known =
    status && status.folder.id === d.folderId
      ? buildPeople(status, [], friendsActor.snapshot().context.friends).people
      : [];
  return d.people.map(
    (p) => known.find((k) => k.key === p.key)?.name ?? (p.name || copy("people.unknown_device")),
  );
}

/** "Removed from Ben's phone." / "Removed from Ben's and Cy's phones."; "" for no names. */
export function droppedText(d: DroppedIn): string {
  if (d.people.length === 0) return "";
  const names = droppedNames(d);
  return copy("lightbox.removed_from_phones", {
    list: nameList(names.map((name) => `${name}'s`)),
    n: names.length,
  });
}

/** Handles dropped pushes. An object so tests can spy on it. */
export const droppedToast = {
  show(d: DroppedIn): void {
    const text = droppedText(d);
    if (text !== "") toast(text);
  },
};
