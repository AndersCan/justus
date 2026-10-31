import { html } from "lit-html";
import {
  $activeFolderId,
  $foldersError,
  $foldersState,
  $foldersViewModel,
  folders,
} from "../machines/folders-machine";
import {
  $onboardingState,
  $onboardingViewModel,
  INTRO_CARD_COUNT,
  onboarding,
} from "../machines/onboarding-machine";
import { $inviteError, invites } from "../machines/invite-machine";
import { $router } from "../router";
import { avatarColor, initialsOf } from "../utils/avatar";
import { useStore } from "../use-store";
import { friendlyError } from "../utils/friendly-error";

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

export const INTRO_CARDS: { icon: string; title: string; body: string }[] = [
  {
    icon: "👥",
    title: "Share photos with the people you choose",
    body: "Family and friends. No account needed.",
  },
  {
    icon: "🚫☁",
    title: "No server",
    body: "Photos are kept only on your phone and the phones of the people you share with.",
  },
  {
    icon: "📷",
    title: "You pick what to share",
    body: "Only the photos you choose or take in Justus are shared. Nothing is added by itself.",
  },
  {
    icon: "✉️",
    title: "Albums and invite links",
    body: "Start an album and send its invite link. Anyone with the link can see the photos, so send it only to people you want in. You decide who can add their own.",
  },
  {
    icon: "📱",
    title: "No cloud copy",
    body: "If a photo is only on a phone that gets lost, it is gone. Once someone else in the album has received it, it is much safer.",
  },
  {
    icon: "📶",
    title: "Use WiFi when you can",
    body: "Photos arrive while you and the others have Justus open. Two phones on mobile data can have trouble reaching each other; WiFi on one of them usually fixes it.",
  },
];

// A saved profile means the device is set up; a relaunch must not replay the intro.
$onboardingState.listen((state) => {
  if (state === "choose") markWelcomeSeen();
});

// Creating an album finishes onboarding: open it once the create lands, so the
// first thing on screen is where photos go. Joining navigates from the albums
// join listener.
let prevFoldersState = $foldersState.get();
$foldersState.listen((state) => {
  if (
    prevFoldersState === "creating" &&
    state === "ok" &&
    !$foldersError.get() &&
    $router.get()?.route === "welcome"
  ) {
    const id = $activeFolderId.get();
    $router.open(id ? `/albums/${id}` : "/", true);
  }
  prevFoldersState = state;
});

let touchStartX = 0;

function cardsStep(card: number) {
  const c = INTRO_CARDS[card];
  const last = card === INTRO_CARD_COUNT - 1;
  return html`
    <div
      class="ui-card mx-auto max-w-md p-8 text-center"
      @touchstart=${(e: TouchEvent) => (touchStartX = e.changedTouches[0].clientX)}
      @touchend=${(e: TouchEvent) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        if (dx < -40) onboarding.next();
        else if (dx > 40 && card > 0) onboarding.back();
      }}
    >
      <p class="text-5xl" aria-hidden="true">${c.icon}</p>
      <h1 class="mt-4 text-xl font-bold text-fg">${c.title}</h1>
      <p class="mt-2 text-sm text-fg">${c.body}</p>
      <div class="mt-6 flex justify-center gap-2" role="presentation">
        ${INTRO_CARDS.map(
          (_, i) =>
            html`<span
              class="h-2 w-2 rounded-full ${i === card ? "bg-accent" : "bg-line"}"
              aria-hidden="true"
            ></span>`,
        )}
      </div>
      <p class="sr-only">Card ${card + 1} of ${INTRO_CARD_COUNT}</p>
    </div>
    <div class="mx-auto mt-6 flex max-w-md items-center justify-between gap-3">
      <button class="ui-btn-ghost" type="button" @click=${() => onboarding.skip()}>Skip</button>
      <div class="flex gap-2">
        ${
          card > 0
            ? html`<button class="ui-btn-ghost" type="button" @click=${() => onboarding.back()}>
                Back
              </button>`
            : null
        }
        <button class="ui-btn-primary" type="button" @click=${() => onboarding.next()}>
          ${last ? "Continue" : "Next"}
        </button>
      </div>
    </div>
  `;
}

function avatar(name: string, size: "lg" | "sm" = "lg") {
  return html`<span
    class="inline-flex items-center justify-center rounded-full font-semibold text-white ${
      size === "lg" ? "h-16 w-16 text-xl" : "h-8 w-8 text-xs"
    }"
    style="background:${avatarColor(name)}"
    aria-hidden="true"
    >${initialsOf(name)}</span
  >`;
}

function profileStep(vm: ReturnType<typeof $onboardingViewModel.get>) {
  return html`
    <form
      class="ui-card mx-auto max-w-md space-y-4 p-6"
      @submit=${(e: SubmitEvent) => {
        e.preventDefault();
        const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
        const name = input.value.trim();
        if (name) onboarding.saveProfile(name);
        else input.focus();
      }}
    >
      <h1 class="text-xl font-bold text-fg">What should we call you?</h1>
      <p class="text-sm text-fg">
        Your name is shared only with the albums you join. It never goes to a server.
      </p>
      <div class="flex items-center gap-4">
        <span data-avatar>${avatar(vm.draftName)}</span>
        <input
          class="ui-input flex-1"
          placeholder="Your name"
          aria-label="Your name"
          maxlength="40"
          required
          autocomplete="name"
          spellcheck="false"
          value="${vm.draftName}"
          @input=${(e: Event) => onboarding.editName((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <p class="text-xs text-muted">
        Your colour and initials come from your name. Edit it later in Settings.
      </p>
      ${vm.error ? html`<p class="text-xs text-danger" role="alert">${friendlyError(vm.error)}</p>` : null}
      <div class="flex justify-between gap-3">
        <button class="ui-btn-ghost" type="button" @click=${() => onboarding.back()}>Back</button>
        <button class="ui-btn-primary" type="submit" ?disabled=${vm.saving}>
          ${vm.saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </form>
  `;
}

function chooseStep() {
  return html`
    <div class="mx-auto max-w-md space-y-4">
      <h1 class="text-center text-xl font-bold text-fg">Start sharing</h1>
      ${useStore($foldersViewModel, (vm) => {
        const busy = vm.state !== "ok";
        return html`
          <form
            class="ui-card space-y-3 p-5"
            @submit=${(e: SubmitEvent) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).querySelector(
                "input",
              ) as HTMLInputElement;
              const name = input.value.trim();
              if (name) folders.create(name);
            }}
          >
            <h2 class="ui-label">Create an album</h2>
            <input
              class="ui-input"
              placeholder="Album name"
              aria-label="Album name"
              maxlength="60"
              required
            />
            <button class="ui-btn-primary w-full" type="submit" ?disabled=${busy}>
              ${vm.state === "creating" ? "Creating…" : "Create an album"}
            </button>
            ${vm.error ? html`<p class="text-xs text-danger" role="alert">${friendlyError(vm.error)}</p>` : null}
          </form>
          <form
            class="ui-card space-y-3 p-5"
            @submit=${(e: SubmitEvent) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).querySelector(
                "input",
              ) as HTMLInputElement;
              invites.receive(input.value);
            }}
          >
            <h2 class="ui-label">Join with an invite link</h2>
            <input
              class="ui-input"
              placeholder="Paste the invite link"
              aria-label="Invite link"
              spellcheck="false"
              autocapitalize="none"
              autocomplete="off"
              autocorrect="off"
              @input=${() => invites.clearError()}
            />
            ${useStore($inviteError, (err) =>
              err
                ? html`<p class="text-xs text-danger" role="alert">${friendlyError(err)}</p>`
                : null,
            )}
            <button class="ui-btn-ghost w-full" type="submit" ?disabled=${busy}>Join album</button>
          </form>
        `;
      })}
    </div>
  `;
}

export function welcomeView() {
  return html`
    <div class="mx-auto max-w-xl space-y-6 py-6">
      <p class="text-center text-3xl font-bold text-accent">Justus</p>
      ${useStore($onboardingViewModel, (vm) => {
        if (vm.fatal) {
          return html`<p class="text-center text-sm text-danger" role="alert">
            Something went wrong. Reload the app to continue.
          </p>`;
        }
        if (vm.state === "cards") return cardsStep(vm.card);
        if (vm.state === "choose") return chooseStep();
        return profileStep(vm);
      })}
    </div>
  `;
}
