import { copy } from "../copy/copy";
import { nameList } from "../utils/people";
import { toast } from "./toast";

export type DroppedIn = { names: string[] };

/** "Removed from Ben's phone." / "Removed from Ben's and Cy's phones."; "" for no names. */
export function droppedText(d: DroppedIn): string {
  if (d.names.length === 0) return "";
  return copy("lightbox.removed_from_phones", {
    list: nameList(d.names.map((name) => `${name}'s`)),
    n: d.names.length,
  });
}

/** Handles dropped pushes. An object so tests can spy on it. */
export const droppedToast = {
  show(d: DroppedIn): void {
    const text = droppedText(d);
    if (text !== "") toast(text);
  },
};
