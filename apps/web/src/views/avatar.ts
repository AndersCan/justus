import { html } from "lit-html";
import { avatarColor, initialsOf } from "../utils/avatar";
import { memberColor } from "../utils/palette";

/** Round avatar: the picture when there is one, else coloured initials. */
export function avatarBadge(name: string, picture = "", size = "h-9 w-9 text-xs") {
  return picture
    ? html`<img
        class="${size} shrink-0 rounded-full object-cover"
        src=${picture}
        alt=""
        aria-hidden="true"
      />`
    : html`<span
        class="inline-flex ${size} shrink-0 items-center justify-center rounded-full font-semibold text-white"
        style="background:${avatarColor(name)}"
        aria-hidden="true"
        >${initialsOf(name)}</span
      >`;
}

/** A person's avatar in an album: the colour of their header dot, from their drive key. */
export function memberBadge(name: string, key: string, size = "h-9 w-9 text-xs") {
  return html`<span
    class="inline-flex ${size} shrink-0 items-center justify-center rounded-full font-semibold text-white"
    style="background:${memberColor(key)}"
    aria-hidden="true"
    >${initialsOf(name)}</span
  >`;
}
