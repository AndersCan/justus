import { Actor, RealClock, event, state } from "@mantaq/core";
import { atom, computed } from "nanostores";
import { gateway } from "../gateway";
import { bindStateAtoms, runInvoke } from "./actor-utils";
import { $userName } from "./folders-machine";

/**
 * First-run onboarding: swipeable intro cards, a required profile step, then
 * the create-or-join choice. Same actor pattern as the other machines; the
 * card index is an atom the change handlers keep in step.
 */

/** Number of intro cards; the view's card list must match. */
export const INTRO_CARD_COUNT = 6;

const ONBOARDING_STATES = ["cards", "profile", "saving", "choose"] as const;
export type OnboardingStateName = (typeof ONBOARDING_STATES)[number];

export const $introCard = atom(0);
export const $onboardingState = atom<OnboardingStateName>("cards");
export const $onboardingError = atom<string | null>(null);
export const $onboardingFatal = atom(false);
/** The name as typed on the profile step, before it is saved; null until the
 * first keystroke. Drives the live avatar preview. */
export const $nameDraft = atom<string | null>(null);

export const $onboardingViewModel = computed(
  [$introCard, $onboardingState, $onboardingError, $onboardingFatal, $userName, $nameDraft],
  (card, state, error, fatal, userName, nameDraft) => ({
    card,
    cardCount: INTRO_CARD_COUNT,
    state,
    saving: state === "saving",
    error,
    fatal,
    userName,
    draftName: nameDraft ?? userName,
  }),
);

/** The person is swiping through the intro cards. */
const cards = state("cards")();
/** The person is asked for their name, which is required to continue. */
const profile = state("profile")();
/** The name is being saved; the button shows progress. */
const saving = state("saving")();
/** The name is saved and the person chooses to create an album or join one. */
const choose = state("choose")();

/** The person goes to the next card or step. */
const next = event("NEXT")();
/** The person goes back a card or step. */
const back = event("BACK")();
/** The person skips the intro cards. */
const skip = event("SKIP")();
/** The person types in the name field. */
const editName = event("EDIT_NAME")<{ name: string }>();
/** The person confirms their name. */
const saveProfile = event("SAVE_PROFILE")<{ name: string }>();
/** The name was saved. */
const saved = event("SAVED")<{ name: string }>();
/** The name could not be saved. */
const saveFailed = event("SAVE_FAILED")<{ message: string }>();

type OnboardingContext = { pendingName: string | null };

export const onboardingActor = Actor({
  inputs: [next, back, skip, editName, saveProfile],
  internal: [saved, saveFailed],
  outputs: [],
  states: [cards, profile, saving, choose],
  initial: cards,
  clock: RealClock(),
  context: { pendingName: null } as OnboardingContext,
  setup: (m) => {
    /** Next card; after the last card the name step opens. */
    m.on(cards, {
      event: next,
      to: [cards, profile],
      handler: () => {
        const card = $introCard.get() + 1;
        if (card >= INTRO_CARD_COUNT) return { state: profile };
        $introCard.set(card);
        return { state: cards };
      },
    });
    /** Previous card; on the first card nothing changes. */
    m.on(cards, {
      event: back,
      to: [cards],
      handler: () => {
        $introCard.set(Math.max(0, $introCard.get() - 1));
        return { state: cards };
      },
    });
    /** Skipping the intro jumps straight to the name step. */
    m.on(cards, { event: skip, to: [profile], handler: () => ({ state: profile }) });

    /** Going back from the name step returns to the last intro card. */
    m.on(profile, {
      event: back,
      to: [cards],
      handler: () => {
        $introCard.set(INTRO_CARD_COUNT - 1);
        return { state: cards };
      },
    });
    /** Typing updates the avatar preview live. */
    m.on(profile, {
      event: editName,
      to: [profile],
      handler: (e) => {
        $nameDraft.set(e.payload.name);
        return { state: profile };
      },
    });
    /** Confirming the name starts saving it and clears any earlier error. */
    m.on(profile, {
      event: saveProfile,
      to: [saving],
      handler: (e, opts) => {
        $onboardingError.set(null);
        opts.context.set({ pendingName: e.payload.name.trim() });
        return { state: saving };
      },
    });
    /** The name is saved; an empty name is refused. */
    m.effect(saving, {
      name: "saving",
      fn: ({ signal, emit, context }) => {
        const name = context.get().pendingName;
        if (!name) {
          emit(saveFailed.create({ message: "Enter a name to continue" }));
          return;
        }
        return runInvoke(
          signal,
          () => gateway.setName(name),
          (result) =>
            emit(saved.create({ name: (result as { name?: string } | null)?.name ?? name })),
          (message) => emit(saveFailed.create({ message })),
        );
      },
    });
    /** The name is saved and the person moves on to create or join an album. */
    m.on(saving, {
      event: saved,
      to: [choose],
      handler: (e, opts) => {
        $userName.set(e.payload.name);
        opts.context.set({ pendingName: null });
        return { state: choose };
      },
    });
    /** Saving failed or the name was empty: the person stays on the name step and sees why. */
    m.on(saving, {
      event: saveFailed,
      to: [profile],
      handler: (e, opts) => {
        $onboardingError.set(e.payload.message);
        opts.context.set({ pendingName: null });
        return { state: profile };
      },
    });
  },
});

bindStateAtoms({
  actor: onboardingActor,
  states: ONBOARDING_STATES,
  $state: $onboardingState,
  $error: $onboardingError,
  $fatal: $onboardingFatal,
});

export const onboarding = {
  next: () => onboardingActor.send(next.create()),
  back: () => onboardingActor.send(back.create()),
  skip: () => onboardingActor.send(skip.create()),
  editName: (name: string) => onboardingActor.send(editName.create({ name })),
  saveProfile: (name: string) => onboardingActor.send(saveProfile.create({ name })),
};
