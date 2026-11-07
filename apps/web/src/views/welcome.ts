import { html } from "lit-html";
import {
  $activeFolderId,
  $foldersError,
  $foldersState,
  $foldersViewModel,
  folders,
} from "../machines/folders-machine";
import { $onboardingState, $onboardingViewModel, onboarding } from "../machines/onboarding-machine";
import { join } from "../machines/sharing/join-request";
import { joinError } from "./albums";
import { currentPage, open } from "../machines/router-machine";
import { avatarColor, initialsOf } from "../utils/avatar";
import { useStore } from "../use-store";
import { friendlyError } from "../utils/friendly-error";
import { INTRO_CARDS, INTRO_CARD_COUNT } from "./intro-cards";
import { wordmark } from "./wordmark";

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
    currentPage()?.route === "welcome"
  ) {
    const id = $activeFolderId.get();
    open(id ? `/albums/${id}` : "/", { replace: true });
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
      ${
        typeof c.icon === "string"
          ? html`<p class="text-5xl" aria-hidden="true">${c.icon}</p>`
          : html`<p class="flex justify-center">${c.icon}</p>`
      }
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
      ${vm.error ? html`<p class="text-xs text-danger-fg" role="alert">${friendlyError(vm.error)}</p>` : null}
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
            ${vm.error ? html`<p class="text-xs text-danger-fg" role="alert">${friendlyError(vm.error)}</p>` : null}
          </form>
          <form
            class="ui-card space-y-3 p-5"
            @submit=${(e: SubmitEvent) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).querySelector(
                "input",
              ) as HTMLInputElement;
              join.openLink(input.value);
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
            />
            ${joinError()}
            <button class="ui-btn-ghost w-full" type="submit" ?disabled=${busy}>Ask to join</button>
          </form>
        `;
      })}
    </div>
  `;
}

export function welcomeView() {
  return html`
    <div class="mx-auto max-w-xl space-y-6 py-6">
      ${useStore($onboardingViewModel, (vm) => {
        if (vm.fatal) {
          return html`<p class="text-center text-sm text-danger-fg" role="alert">
            Something went wrong. Reload the app to continue.
          </p>`;
        }
        // The first card carries the logo itself, so the header would double it.
        // md+: the rail already shows the wordmark; one coral dot per screen.
        const header =
          vm.state === "cards" && vm.card === 0
            ? null
            : html`<h1 class="flex justify-center md:hidden">${wordmark("h-14 w-auto", true)}</h1>`;
        const step =
          vm.state === "cards"
            ? cardsStep(vm.card)
            : vm.state === "choose"
              ? chooseStep()
              : profileStep(vm);
        return html`${header}${step}`;
      })}
    </div>
  `;
}
