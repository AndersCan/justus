import { Actor, RealClock, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { LockStatus } from "@justus/core";
import { gateway } from "../gateway";
import { fatalErrorOf, runInvoke, stateNameOf } from "./actor-utils";
import { INTRO_CARD_COUNT } from "../views/intro-cards";
import { foldersActor, nameSeen } from "./folders-machine";

import { copy } from "../copy/copy";
/**
 * First-run onboarding: swipeable intro cards, a required profile step, then
 * the create-or-join choice. The card index, name
 * draft and error live in context; and the screen reads them with `watch`.
 */

export { INTRO_CARD_COUNT };

export const ONBOARDING_STATES = [
  "showingIntroCards",
  "askingForName",
  "savingName",
  "offeringAppLock",
  "turningOnAppLock",
  "choosingCreateOrJoin",
] as const;
export type OnboardingStateName = (typeof ONBOARDING_STATES)[number];

const nameOf = stateNameOf(ONBOARDING_STATES);

/** The app's tabs show everywhere except the first-run welcome before the name is saved. */
export function showsAppNav(route: string | undefined, onboardingState: ReturnType<typeof nameOf>) {
  return route !== "welcome" || onboardingState === "choosingCreateOrJoin";
}

/** The onboarding UI's view model as a pure function of the actor snapshot and
 * the device's saved name (owned by folders). */
export function onboardingViewModel(s: Snapshot<OnboardingContext>, userName: string) {
  const state = nameOf(s);
  const fatal = fatalErrorOf(s);
  return {
    card: s.context.card,
    cardCount: INTRO_CARD_COUNT,
    state,
    saving: state === "savingName",
    turningOnLock: state === "turningOnAppLock",
    error: fatal?.message ?? s.context.error,
    fatal: fatal !== null,
    userName,
    // Never prefill from the stored name: it is a generated default, not the person's choice.
    draftName: s.context.draftName ?? "",
  };
}

/** The person is swiping through the intro cards. */
const showingIntroCards = state("showingIntroCards")();
/** The person is asked for their name, which is required to continue. */
const askingForName = state("askingForName")();
/** The name is being saved; the button shows progress. */
const savingName = state("savingName")();
/** The name is saved and the phone has a screen lock: the person is asked whether to lock Justus with it. */
const offeringAppLock = state("offeringAppLock")();
/** The phone's own fingerprint, face or PIN prompt is open to confirm turning App lock on. */
const turningOnAppLock = state("turningOnAppLock")();
/** The name is saved and the person chooses to create an album or join one. The onboarding machine ends here. */
const choosingCreateOrJoin = state("choosingCreateOrJoin")().final();

/** The person goes to the next card or step. */
const next = event("NEXT")();
/** The person goes back a card or step. */
const back = event("BACK")();
/** The person skips the intro cards. */
const skip = event("SKIP")();
/** The person types in the name field. */
const editName = event("EDIT_NAME")<{ name: string }>();
/** The person confirms the name they typed. */
const saveProfile = event("SAVE_PROFILE")();
/** The name was saved. */
const saved = event("SAVED")<{ name: string }>();
/** The name could not be saved. */
const saveFailed = event("SAVE_FAILED")<{ message: string }>();
/** The phone reported whether it has a screen lock and whether App lock is on. */
const lockStatusRead = event("LOCK_STATUS_READ")<{ status: LockStatus }>();
/** The person taps Enable on "Lock Justus?". */
const turnOnAppLock = event("TURN_ON_APP_LOCK")();
/** The person taps Not now on "Lock Justus?". */
const skipAppLock = event("SKIP_APP_LOCK")();
/** The person confirmed: App lock is on. */
const appLockTurnedOn = event("APP_LOCK_TURNED_ON")();
/** The person cancelled the phone's prompt: App lock stays off. */
const appLockLeftOff = event("APP_LOCK_LEFT_OFF")();
/** The phone's prompt failed: App lock stays off and the person sees why. */
const appLockFailed = event("APP_LOCK_FAILED")<{ message: string }>();
/** The name was saved; the app records it as the person's name. */
const nameSaved = event("NAME_SAVED")<{ name: string }>();

const APP_LOCK_FAILED_MESSAGE = copy("onboarding.couldn_t_turn_on_app");

type OnboardingContext = {
  card: number;
  draftName: string | null;
  pendingName: string | null;
  error: string | null;
  lock: LockStatus | undefined;
};

const initialContext: OnboardingContext = {
  card: 0,
  draftName: null,
  pendingName: null,
  error: null,
  lock: undefined,
};

/** Where the person's name is saved; the real gateway unless a test or the inspector supplies one. */
export type OnboardingPort = Pick<typeof gateway, "setName" | "lock">;

export function createOnboardingActor(options: { clock: Clock; gateway?: OnboardingPort }) {
  const port = options.gateway ?? gateway;
  return Actor({
    inputs: [next, back, skip, editName, saveProfile, lockStatusRead, turnOnAppLock, skipAppLock],
    internal: [saved, saveFailed, appLockTurnedOn, appLockLeftOff, appLockFailed],
    outputs: [nameSaved],
    states: [
      showingIntroCards,
      askingForName,
      savingName,
      offeringAppLock,
      turningOnAppLock,
      choosingCreateOrJoin,
    ],
    initial: showingIntroCards,
    clock: options.clock,
    context: initialContext,
    setup: (m) => {
      /** The phone's lock status is remembered in any state; it never moves the person. */
      m.onAny({
        event: lockStatusRead,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), lock: e.payload.status });
          return {};
        },
      });
      /** Next card; after the last card the name step opens. */
      m.on(showingIntroCards, {
        event: next,
        to: [showingIntroCards, askingForName],
        handler: (_e, opts) => {
          const card = opts.context.get().card + 1;
          if (card >= INTRO_CARD_COUNT) return { state: askingForName };
          opts.context.set({ ...opts.context.get(), card });
          return { state: showingIntroCards };
        },
      });
      /** Previous card; on the first card nothing changes. */
      m.on(showingIntroCards, {
        event: back,
        to: [showingIntroCards],
        handler: (_e, opts) => {
          const current = opts.context.get();
          opts.context.set({ ...current, card: Math.max(0, current.card - 1) });
          return { state: showingIntroCards };
        },
      });
      /** Skipping the intro jumps straight to the name step. */
      m.on(showingIntroCards, {
        event: skip,
        to: [askingForName],
        handler: () => ({ state: askingForName }),
      });

      /** Going back from the name step returns to the card the person left from. */
      m.on(askingForName, {
        event: back,
        to: [showingIntroCards],
        handler: () => ({ state: showingIntroCards }),
      });
      /** Typing updates the avatar preview live. */
      m.on(askingForName, {
        event: editName,
        to: [askingForName],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), draftName: e.payload.name });
          return { state: askingForName };
        },
      });
      /** Confirming the name starts saving it and clears any earlier error. */
      m.on(askingForName, {
        event: saveProfile,
        to: [savingName],
        handler: (_e, opts) => {
          const current = opts.context.get();
          opts.context.set({
            ...current,
            error: null,
            pendingName: (current.draftName ?? "").trim(),
          });
          return { state: savingName };
        },
      });
      /** The name is saved; an empty name is refused. */
      m.effect(savingName, {
        name: "savingName",
        sends: [saved, saveFailed],
        fn: ({ signal, emit, context }) => {
          const name = context.get().pendingName;
          if (!name) {
            emit(saveFailed.create({ message: copy("onboarding.enter_a_name_to_continue") }));
            return;
          }
          return runInvoke(
            signal,
            () => port.setName(name),
            (result) =>
              emit(saved.create({ name: (result as { name?: string } | null)?.name ?? name })),
            (message) => emit(saveFailed.create({ message })),
          );
        },
      });
      /** The name is saved; a phone with a screen lock and App lock off is offered App lock, then the person moves on to create or join an album. */
      m.on(savingName, {
        event: saved,
        to: [choosingCreateOrJoin, offeringAppLock],
        handler: (e, opts) => {
          const current = opts.context.get();
          opts.context.set({ ...current, pendingName: null });
          const offer = current.lock?.available === true && current.lock.enabled === false;
          return {
            state: offer ? offeringAppLock : choosingCreateOrJoin,
            emit: [nameSaved.create({ name: e.payload.name })],
          };
        },
      });
      /** Enable opens the phone's own prompt. */
      m.on(offeringAppLock, {
        event: turnOnAppLock,
        to: [turningOnAppLock],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), error: null });
          return { state: turningOnAppLock };
        },
      });
      /** Not now moves on without App lock. */
      m.on(offeringAppLock, {
        event: skipAppLock,
        to: [choosingCreateOrJoin],
        handler: () => ({ state: choosingCreateOrJoin }),
      });
      /** The phone is asked to turn App lock on; a cancel or a failure leaves it off; a failure says so. */
      m.effect(turningOnAppLock, {
        name: "turningOnAppLock",
        sends: [appLockTurnedOn, appLockLeftOff, appLockFailed],
        fn: ({ signal, emit }) =>
          runInvoke(
            signal,
            () => port.lock.setEnabled(true),
            (result) =>
              emit(
                (result as { enabled?: boolean } | null)?.enabled === true
                  ? appLockTurnedOn.create()
                  : appLockLeftOff.create(),
              ),
            () => emit(appLockFailed.create({ message: APP_LOCK_FAILED_MESSAGE })),
          ),
      });
      /** The person confirmed: App lock is on and they move on. */
      m.on(turningOnAppLock, {
        event: appLockTurnedOn,
        to: [choosingCreateOrJoin],
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), lock: { available: true, enabled: true } });
          return { state: choosingCreateOrJoin };
        },
      });
      /** The prompt failed: back on "Lock Justus?" with the error. */
      m.on(turningOnAppLock, {
        event: appLockFailed,
        to: [offeringAppLock],
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), error: e.payload.message });
          return { state: offeringAppLock };
        },
      });
      /** Cancelled: back on "Lock Justus?". */
      m.on(turningOnAppLock, {
        event: appLockLeftOff,
        to: [offeringAppLock],
        handler: () => ({ state: offeringAppLock }),
      });
      /** Saving failed or the name was empty: the person stays on the name step and sees why. */
      m.on(savingName, {
        event: saveFailed,
        to: [askingForName],
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            error: e.payload.message,
            pendingName: null,
          });
          return { state: askingForName };
        },
      });
    },
  });
}

export const onboardingActor = createOnboardingActor({ clock: RealClock() });

onboardingActor.on("output", {
  fn: (e) => {
    const payload = e.payload;
    if (typeof payload !== "object" || payload === null || !("name" in payload)) return;
    if (typeof payload.name === "string")
      foldersActor.send(nameSeen.create({ name: payload.name }));
  },
});

export const onboarding = {
  state: () => nameOf(onboardingActor.snapshot()),
  next: () => onboardingActor.send(next.create()),
  back: () => onboardingActor.send(back.create()),
  skip: () => onboardingActor.send(skip.create()),
  editName: (name: string) => onboardingActor.send(editName.create({ name })),
  saveProfile: () => onboardingActor.send(saveProfile.create()),
  lockStatusRead: (status: LockStatus) => onboardingActor.send(lockStatusRead.create({ status })),
  turnOnAppLock: () => onboardingActor.send(turnOnAppLock.create()),
  skipAppLock: () => onboardingActor.send(skipAppLock.create()),
};
