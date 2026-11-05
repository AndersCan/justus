import { html, type TemplateResult } from "lit-html";
import { justus, wordmark } from "./wordmark";

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
    icon: "📷",
    title: "You pick what to share",
    body: "Only the photos you choose are shared. Nothing gets added by itself.",
  },
  {
    icon: "✉️",
    title: "Create Albums and share them",
    body: "An album can be shared via a link or QR code. Anyone with the link can request to join your album",
  },
  {
    icon: "🔄",
    title: "Both of you need to be online",
    body: html`Photos move directly between phones, so you and your friends need ${justus()} open at
    the same time.`,
  },
  {
    icon: "📶",
    title: "WiFi works best",
    body: "Phones on mobile data can have trouble finding each other. If sharing stalls, try WiFi on one of them.",
  },
  {
    icon: "📱",
    title: "Made for sharing, not backup",
    body: html`Photos you share are shared to your friends' phones, so ${justus()} might seem like a
    backup solution, but that's not what ${justus()} is made for (or good at).`,
  },
];

/** Number of intro cards; derived so adding a card cannot desync the machine. */
export const INTRO_CARD_COUNT = INTRO_CARDS.length;
