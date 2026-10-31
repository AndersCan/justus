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

const cards = state("cards")();
const profile = state("profile")();
const saving = state("saving")();
const choose = state("choose")();

const next = event("NEXT")();
const back = event("BACK")();
const skip = event("SKIP")();
const editName = event("EDIT_NAME")<{ name: string }>();
const saveProfile = event("SAVE_PROFILE")<{ name: string }>();
const saved = event("SAVED")<{ name: string }>();
const saveFailed = event("SAVE_FAILED")<{ message: string }>();

type OnboardingContext = { pendingName: string | null };

const onboardingActor = new Actor({
  inputs: [next, back, skip, editName, saveProfile],
  internal: [saved, saveFailed],
  outputs: [],
  states: [cards, profile, saving, choose],
  initial: cards,
  clock: new RealClock(),
  context: { pendingName: null } as OnboardingContext,
  setup: (m) => {
    m.on(cards, next, () => {
      const card = $introCard.get() + 1;
      if (card >= INTRO_CARD_COUNT) return { state: profile };
      $introCard.set(card);
      return { state: cards };
    });
    m.on(cards, back, () => {
      $introCard.set(Math.max(0, $introCard.get() - 1));
      return { state: cards };
    });
    m.on(cards, skip, () => ({ state: profile }));

    m.on(profile, back, () => {
      $introCard.set(INTRO_CARD_COUNT - 1);
      return { state: cards };
    });
    m.on(profile, editName, (e) => {
      $nameDraft.set(e.payload.name);
      return { state: profile };
    });
    m.on(profile, saveProfile, (e, opts) => {
      $onboardingError.set(null);
      opts.context.set({ pendingName: e.payload.name.trim() });
      return { state: saving };
    });
    m.effect(saving, ({ signal, emit, context }) => {
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
    });
    m.on(saving, saved, (e, opts) => {
      $userName.set(e.payload.name);
      opts.context.set({ pendingName: null });
      return { state: choose };
    });
    m.on(saving, saveFailed, (e, opts) => {
      $onboardingError.set(e.payload.message);
      opts.context.set({ pendingName: null });
      return { state: profile };
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
