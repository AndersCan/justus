import { html, type TemplateResult } from "lit-html";

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
    title: "No server in the middle",
    body: "Your photos go straight from your phone to the phones of the people you share with. Nobody else gets a copy, not even us. No account needed.",
  },
  {
    icon: "✉️",
    title: "You decide who joins",
    body: "Share an album with a link or QR code. The link alone shows no photos: you accept each person who asks to join, and only the photos you pick are added.",
  },
];

/** Number of intro cards; derived so adding a card cannot desync the machine. */
export const INTRO_CARD_COUNT = INTRO_CARDS.length;
