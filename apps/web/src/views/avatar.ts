import { html } from "lit-html";
import { avatarColor, initialsOf } from "../utils/avatar";

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
