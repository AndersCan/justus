import { html } from "lit-html";
import { computed } from "nanostores";
import { useStore } from "../use-store";
import { $syncFatal, $syncStatus } from "../machines/sync-machine";
import { connectionLabel, connectionTone } from "../connection-tone";

/** Single source of truth for the header indicator: derive tone + label from
 * the live sync status (peer count) and the fatal flag. */
export const $connection = computed([$syncStatus, $syncFatal], (status, fatal) => {
  const peers = status?.peers ?? 0;
  return { tone: connectionTone(peers, fatal), label: connectionLabel(peers, fatal), peers };
});

const TONE_TEXT: Record<string, string> = {
  green: "text-trust-green",
  amber: "text-trust-amber",
  red: "text-trust-red",
};

const TONE_DOT: Record<string, string> = {
  green: "bg-trust-green",
  amber: "bg-trust-amber",
  red: "bg-trust-red",
};

/**
 * Calm, always-visible p2p trust indicator (vision: "Connection state is
 * always legible"). A colored dot + "direct · N peer(s)" label. Green = at
 * least one direct peer; amber = direct but no peers yet; red = sync stopped
 * (reload). The "no server" half of the privacy promise is constant — justus
 * is p2p by architecture, so the label always leads with "direct".
 */
export function connectionIndicator() {
  return useStore(
    $connection,
    (c) => html`
      <span
        class="flex items-center gap-1.5 text-xs ${TONE_TEXT[c.tone]}"
        role="status"
        aria-live="polite"
        title="justus is peer-to-peer — photos sync directly between devices, with no server involved."
      >
        <span
          class="inline-block h-2 w-2 rounded-full ${TONE_DOT[c.tone]}"
          aria-hidden="true"
        ></span>
        <span>${c.label}</span>
      </span>
    `,
  );
}
