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

/** A person's avatar in an album: their seat colour, or an outline when they have none. */
export function memberBadge(name: string, color: number | undefined, size = "h-9 w-9 text-xs") {
  const fill = memberColor(color);
  return fill === undefined
    ? html`<span
        class="inline-flex ${size} shrink-0 items-center justify-center rounded-full bg-subtle font-semibold text-muted ring-1 ring-inset ring-line"
        aria-hidden="true"
        >${initialsOf(name)}</span
      >`
    : html`<span
        class="inline-flex ${size} shrink-0 items-center justify-center rounded-full font-semibold text-white"
        style="background:${fill}"
        aria-hidden="true"
        >${initialsOf(name)}</span
      >`;
}
