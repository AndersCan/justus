import { html } from "lit-html";
import { watch } from "@mantaq/lit";
import {
  FOLDERS_STATES,
  folders,
  foldersActor,
  foldersViewModel,
} from "../machines/folders-machine";
import {
  ONBOARDING_STATES,
  onboarding,
  onboardingActor,
  onboardingViewModel,
} from "../machines/onboarding-machine";
import { onStateChange } from "../machines/actor-utils";
import { joinPanel, pendingAsks } from "./albums";
import { currentPage, open } from "../machines/router-machine";
import { avatarColor, initialsOf } from "../utils/avatar";
import { gateway } from "../gateway";
import { join } from "../machines/sharing/join-request";
import { isLockStatus } from "./app-lock";
import { toast } from "./toast";
import { friendlyError } from "../utils/friendly-error";
import { INTRO_CARDS, INTRO_CARD_COUNT } from "./intro-cards";
import { wordmark } from "./wordmark";

import { copy, t } from "../copy/copy";
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
onStateChange(onboardingActor, ONBOARDING_STATES, (state) => {
  if (state === "choosingCreateOrJoin") {
    markWelcomeSeen();
    join.welcomeEnded();
  }
});

/**
 * The phone remembers its albums, but the seen flag lives in the page origin, which the Android
 * shell changes on every launch (the worklet picks a free port). An album on the phone means the
 * device is set up: skip the intro instead of replaying it. The name does not tell: the worklet
 * makes one up on a first run.
 */
export function leavesWelcomeForSavedProfile(
  hasAlbums: boolean,
  state: string,
  route: string | undefined,
): boolean {
  return (
    hasAlbums && route === "welcome" && (state === "showingIntroCards" || state === "askingForName")
  );
}

foldersActor.on("change", {
  fn: (snapshot) => {
    const state = String(onboardingActor.snapshot().path[0]);
    if (
      !leavesWelcomeForSavedProfile(
        snapshot.context.folders.length > 0,
        state,
        currentPage()?.route,
      )
    )
      return;
    markWelcomeSeen();
    join.welcomeEnded();
    open("/", { replace: true });
  },
});

// Turning App lock on from the first-run card confirms itself, as the Settings switch does.
onStateChange(onboardingActor, ONBOARDING_STATES, (state, prev) => {
  if (prev === "turningOnAppLock" && state === "choosingCreateOrJoin")
    toast(copy("welcome.app_lock_is_on"));
});

/** Tells onboarding whether the phone has a screen lock; elsewhere, or on any error, the card is skipped. */
export async function readLockForOnboarding(load = gateway.lock.status) {
  if ((window as { BareShell?: boolean }).BareShell !== true) return;
  const [err, status] = await load();
  if (!err && isLockStatus(status)) onboarding.lockStatusRead(status);
}

// Creating an album finishes onboarding: open it once the create lands, so the
// first thing on screen is where photos go. Joining opens the album when the
// Admin accepts (join-request.ts).
onStateChange(foldersActor, FOLDERS_STATES, (next, prev) => {
  const { error, activeId } = foldersActor.snapshot().context;
  if (
    prev === "creatingAlbum" &&
    next === "showingAlbums" &&
    !error &&
    currentPage()?.route === "welcome"
  ) {
    open(activeId ? `/albums/${activeId}` : "/", { replace: true });
  }
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
      <p class="sr-only">${t("welcome.card_of", { current: card + 1, total: INTRO_CARD_COUNT })}</p>
    </div>
    <div class="mx-auto mt-6 flex max-w-md items-center justify-between gap-3">
      ${
        last
          ? html`<span></span>`
          : html`<button class="ui-btn-ghost" type="button" @click=${() => onboarding.skip()}>
              ${t("welcome.skip")}
            </button>`
      }
      <div class="flex gap-2">
        ${
          card > 0
            ? html`<button class="ui-btn-ghost" type="button" @click=${() => onboarding.back()}>
                ${t("welcome.back")}
              </button>`
            : null
        }
        <button class="ui-btn-primary" type="button" @click=${() => onboarding.next()}>
          ${last ? copy("welcome.continue") : copy("welcome.next")}
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

function profileStep(vm: ReturnType<typeof onboardingViewModel>) {
  return html`
    <form
      class="ui-card mx-auto max-w-md space-y-4 p-6"
      @submit=${(e: SubmitEvent) => {
        e.preventDefault();
        const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
        const name = input.value.trim();
        if (name) {
          onboarding.editName(name);
          onboarding.saveProfile();
        } else input.focus();
      }}
    >
      <h1 class="text-xl font-bold text-fg">${t("welcome.what_should_we_call_you")}</h1>
      <p class="text-sm text-fg">${t("welcome.your_name_is_shared_only")}</p>
      <div class="flex items-center gap-4">
        <span data-avatar>${avatar(vm.draftName)}</span>
        <input
          class="ui-input flex-1"
          placeholder=${copy("welcome.your_name")}
          aria-label=${copy("welcome.your_name")}
          maxlength="40"
          required
          autocomplete="name"
          spellcheck="false"
          value="${vm.draftName}"
          @input=${(e: Event) => onboarding.editName((e.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <p class="text-xs text-muted">${t("welcome.your_colour_and_initials_come")}</p>
      ${vm.error ? html`<p class="text-xs text-danger-fg" role="alert">${friendlyError(vm.error)}</p>` : null}
      <div class="flex justify-between gap-3">
        <button class="ui-btn-ghost" type="button" @click=${() => onboarding.back()}>
          ${t("welcome.back")}
        </button>
        <button class="ui-btn-primary" type="submit" ?disabled=${vm.saving}>
          ${vm.saving ? copy("welcome.saving") : copy("welcome.continue")}
        </button>
      </div>
    </form>
  `;
}

function lockStep(vm: ReturnType<typeof onboardingViewModel>) {
  return html`
    <div class="ui-card mx-auto max-w-md space-y-4 p-6">
      <h2 class="text-xl font-bold text-fg">${t("welcome.lock_justus")}</h2>
      <p class="text-sm text-fg">${t("welcome.uses_your_phone_s_fingerprint")}</p>
      <div class="flex justify-between gap-3">
        <button
          class="ui-btn-ghost"
          type="button"
          ?disabled=${vm.turningOnLock}
          @click=${() => onboarding.skipAppLock()}
        >
          ${t("welcome.not_now")}
        </button>
        <button
          class="ui-btn-primary"
          type="button"
          ?disabled=${vm.turningOnLock}
          @click=${() => onboarding.turnOnAppLock()}
        >
          ${t("welcome.enable")}
        </button>
      </div>
    </div>
  `;
}

function chooseStep() {
  return html`
    <div class="mx-auto max-w-md space-y-4">
      <h1 class="text-center text-xl font-bold text-fg">${t("welcome.start_sharing")}</h1>
      ${pendingAsks()}
      ${watch(foldersActor, (s) => {
        const vm = foldersViewModel(s);
        const busy = !vm.settled;
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
            <h2 class="ui-label">${t("welcome.create_an_album")}</h2>
            <input
              class="ui-input"
              placeholder=${copy("welcome.album_name")}
              aria-label=${copy("welcome.album_name")}
              maxlength="60"
              required
            />
            <wa-button variant="brand" class="w-full" type="submit" ?disabled=${busy}>
              ${vm.state === "creatingAlbum" ? copy("welcome.creating") : copy("welcome.create_an_album")}
            </wa-button>
            ${vm.error ? html`<p class="text-xs text-danger-fg" role="alert">${friendlyError(vm.error)}</p>` : null}
          </form>
        `;
      })}
      ${joinPanel()}
    </div>
  `;
}

export function welcomeView() {
  return html`
    <div class="mx-auto max-w-xl space-y-6 py-6">
      ${watch(onboardingActor, (os) =>
        watch(foldersActor, (fs) => {
          const vm = onboardingViewModel(os, fs.context.userName);
          if (vm.fatal) {
            return html`<p class="text-center text-sm text-danger-fg" role="alert">
              ${t("welcome.something_went_wrong_reload_the")}
            </p>`;
          }
          // The first card carries the logo itself, so the header would double it.
          // md+: the rail already shows the wordmark; one coral dot per screen.
          const header =
            vm.state === "showingIntroCards" && vm.card === 0
              ? null
              : html`<h1 class="flex justify-center md:hidden">
                  ${wordmark("h-14 w-auto", true)}
                </h1>`;
          const step =
            vm.state === "showingIntroCards"
              ? cardsStep(vm.card)
              : vm.state === "choosingCreateOrJoin"
                ? chooseStep()
                : vm.state === "offeringAppLock" || vm.state === "turningOnAppLock"
                  ? lockStep(vm)
                  : profileStep(vm);
          return html`${header}${step}`;
        }),
      )}
    </div>
  `;
}
