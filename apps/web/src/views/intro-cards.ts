import type { TemplateResult } from "lit-html";
import { wordmark } from "./wordmark";

export const INTRO_CARDS: {
  /** An emoji, or a template (the first card shows the logo). */
  icon: TemplateResult | string;
  title: TemplateResult | string;
  body: TemplateResult | string;
}[] = [
  {
    icon: wordmark("h-14 w-auto", true),
    title: "Welcome",
    body: "Share photos directly with family and friends. No account needed.",
  },
  {
    icon: "🚫☁",
    title: "No servers, no accounts",
    body: "Your photos stay on your phone and on the phones of the people you share with. We never see them.",
  },
  {
    icon: "✉️",
    title: "You decide who joins",
    body: "Share an album with a link or QR code. The link alone shows no photos: you accept each person who asks to join, and only the photos you pick are added.",
  },
];

/** Number of intro cards; derived so adding a card cannot desync the machine. */
export const INTRO_CARD_COUNT = INTRO_CARDS.length;
