import { html, type TemplateResult } from "lit-html";

import { copy } from "../copy/copy";
function phoneToPhone(): TemplateResult {
  return html`<svg
    class="h-28 w-auto text-fg"
    viewBox="0 0 240 120"
    fill="none"
    stroke="currentColor"
    stroke-width="3"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <g class="text-muted">
      <path d="M96 38h38a10 10 0 0 0 0-20a15 15 0 0 0-28-4a11 11 0 0 0-10 24z" />
      <path d="M97 8l46 34" />
    </g>
    <rect x="20" y="40" width="48" height="76" rx="9" />
    <rect x="172" y="40" width="48" height="76" rx="9" />
    <path class="text-muted" d="M76 78h88" stroke-dasharray="2 7" />
    <rect x="181" y="69" width="30" height="20" rx="3" fill="currentColor" stroke="none" />
  </svg>`;
}

export const INTRO_CARDS: {
  /** An emoji, or a template (the first card shows a drawing). */
  icon: TemplateResult | string;
  title: TemplateResult | string;
  body: TemplateResult | string;
}[] = [
  {
    icon: phoneToPhone(),
    title: copy("intro_cards.no_server_in_the_middle"),
    body: copy("intro_cards.your_photos_go_straight_from"),
  },
  {
    icon: "✉️",
    title: copy("intro_cards.you_decide_who_joins"),
    body: copy("intro_cards.share_an_album_with_a"),
  },
];

/** Number of intro cards; derived so adding a card cannot desync the machine. */
export const INTRO_CARD_COUNT = INTRO_CARDS.length;
