import { $router } from "../router";
import { html } from "lit-html";

const SEEN_KEY = "justus:welcome-seen";

/** Whether the first-run welcome screen has been dismissed on this install. */
export function hasSeenWelcome(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/** Persist that the welcome screen has been seen (best-effort). */
export function markWelcomeSeen(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // storage unavailable (private mode / non-browser) — ignore
  }
}

// Dismissing hands off to the folder create/join screen, where a first folder is named and an invite key pasted.
function enterApp(): void {
  markWelcomeSeen();
  $router.open("/settings", true);
}

export function welcomeView() {
  return html`
    <div class="mx-auto max-w-xl space-y-8 py-6">
      <div class="text-center">
        <p class="font-serif text-3xl font-bold text-clay">Justus</p>
        <p class="mt-2 text-cocoa">
          Your photos, passed directly between your devices and people. No server ever holds them.
        </p>
      </div>

      <div
        class="warm-card mx-auto max-w-md p-6 text-center"
        role="img"
        aria-label="Your device passes photos directly to a peer. No cloud relay sits between them."
      >
        <div class="flex items-center justify-center gap-3 text-4xl">
          <span aria-hidden="true">📱</span>
          <span class="inline-flex items-center" aria-hidden="true">
            <span
              class="h-2.5 w-2.5 rounded-full bg-clay animate-pulse motion-reduce:animate-none"
            ></span>
          </span>
          <span aria-hidden="true">👥</span>
        </div>
        <p class="mt-3 text-sm text-cocoa">photos move directly between your devices</p>
        <p class="mt-1 text-xs text-taupe line-through" aria-hidden="true">
          ☁ no server in between
        </p>
      </div>

      <ul class="mx-auto max-w-md space-y-3 text-left text-sm text-cocoa">
        <li><strong>No account.</strong> Nothing to sign up for; nothing to log into.</li>
        <li><strong>Peers hold your data.</strong> Photos live only on devices you choose.</li>
        <li><strong>Works offline.</strong> Devices sync when they see each other.</li>
      </ul>

      <div class="flex flex-col items-center gap-3">
        <button class="warm-pill" type="button" @click=${() => enterApp()}>
          Create your first folder
        </button>
        <button class="warm-ghost" type="button" @click=${() => enterApp()}>
          Join someone's folder
        </button>
      </div>
    </div>
  `;
}
