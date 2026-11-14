import { html } from "lit-html";
import { avatarColor, initialsOf } from "../utils/avatar";
import { memberColor } from "../utils/palette";

/** Round avatar: the picture when there is one, else coloured initials. */
export function avatarBadge(name: string, picture = "", size = "ui-avatar-md") {
  return picture
    ? html`<img
        class="${size} shrink-0 ui-avatar-photo"
        src=${picture}
        alt=""
        aria-hidden="true"
      />`
    : html`<span
        class="${size} shrink-0 ui-avatar"
        style="background:${avatarColor(name)}"
        aria-hidden="true"
        >${initialsOf(name)}</span
      >`;
}

/** A person's avatar in an album: their seat colour, or an outline when they have none. */
export function memberBadge(name: string, color: number | undefined, size = "ui-avatar-md") {
  const fill = memberColor(color);
  return fill === undefined
    ? html`<span class="${size} shrink-0 ui-avatar-outline" aria-hidden="true"
        >${initialsOf(name)}</span
      >`
    : html`<span class="${size} shrink-0 ui-avatar" style="background:${fill}" aria-hidden="true"
        >${initialsOf(name)}</span
      >`;
}
