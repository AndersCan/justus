import { html } from "lit-html";
import { watch } from "@mantaq/lit";
import { folders, foldersActor, foldersViewModel } from "../machines/folders-machine";
import { sync, syncActor, syncViewModel } from "../machines/sync-machine";
import { pathFor } from "../machines/router-machine";
import { prefsActor } from "../machines/prefs-machine";
import { clearProfilePicture, setProfilePictureFromFile } from "../utils/profile-picture";
import { avatarBadge } from "./avatar";
import { errorBanner } from "./error-banner";
import { logsPanel } from "./logs";
import { appLockSection, refreshAppLock } from "./app-lock";
import { densitySetting, themeSetting } from "./theme-toggle";
import { toast } from "./toast";

import { copy, t } from "../copy/copy";
type SyncViewModel = ReturnType<typeof syncViewModel>;
type FoldersViewModel = ReturnType<typeof foldersViewModel>;

async function pickPicture(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    if (!(await setProfilePictureFromFile(file))) toast(copy("settings.couldn_t_save_the_picture"));
  } catch {
    toast(copy("settings.that_file_isn_t_a"));
  }
}

function pictureRow(name: string) {
  return watch(
    prefsActor,
    ({ context: { picture } }) => html`<div class="mb-4 flex items-center gap-4">
      ${avatarBadge(name || "?", picture, "h-16 w-16 text-xl")}
      <div class="flex flex-wrap gap-2">
        <label class="ui-btn-ghost cursor-pointer">
          ${picture ? copy("settings.change_picture") : copy("settings.add_picture")}
          <input class="sr-only" type="file" accept="image/*" @change=${pickPicture} />
        </label>
        ${
          picture
            ? html`<button class="ui-btn-ghost" type="button" @click=${clearProfilePicture}>
                ${t("settings.remove")}
              </button>`
            : null
        }
      </div>
    </div>`,
  );
}

function profileSection(view: FoldersViewModel) {
  const saving = view.state === "savingName";
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">${t("settings.profile")}</h2>
      <p class="mb-4 text-sm text-fg">${t("settings.your_name_is_shown_to")}</p>
      ${pictureRow(view.userName)}
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          const name = input.value.trim();
          if (name && name !== view.userName) folders.rename(name);
        }}
      >
        <input
          class="ui-input flex-1"
          placeholder=${copy("settings.your_name")}
          aria-label=${copy("settings.your_name")}
          value="${view.userName}"
          spellcheck="false"
          autocomplete="name"
        />
        <button class="ui-btn-primary" type="submit" ?disabled=${saving}>
          ${saving ? copy("settings.saving") : copy("settings.save")}
        </button>
      </form>
    </section>
  `;
}

function appearanceSection() {
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-3">${t("settings.appearance")}</h2>
      ${themeSetting()}
      <h3 class="ui-label mb-3 mt-5">${t("settings.photo_grid")}</h3>
      ${densitySetting()}
    </section>
  `;
}

function helpSection() {
  return html`<a
    class="ui-card ui-focus flex items-center justify-between gap-3 p-5 hover:bg-subtle"
    href=${pathFor("help")}
  >
    <span>
      <span class="block text-sm font-medium text-fg">${t("settings.help")}</span>
      <span class="mt-0.5 block text-xs text-muted">${t("settings.how_peer_to_peer_works")}</span>
    </span>
    <span class="text-muted" aria-hidden="true">›</span>
  </a>`;
}

function advancedSection() {
  return html`<details class="text-xs text-muted">
    <summary class="ui-label cursor-pointer select-none">${t("settings.advanced")}</summary>
    <div class="mt-3">${logsPanel()}</div>
  </details>`;
}

function bindingsBody(foldersVm: FoldersViewModel, syncVm: SyncViewModel) {
  const { state, error, fatal } = syncVm;
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">${t("settings.settings")}</h1>

      ${errorBanner(
        error || foldersVm.error,
        (state === "couldNotCheckAlbum" || foldersVm.state === "couldNotLoadAlbums") &&
          !fatal &&
          !foldersVm.fatal
          ? () => {
              sync.retry();
              folders.retry();
            }
          : undefined,
        fatal || foldersVm.fatal ? () => window.location.reload() : undefined,
      )}
      ${profileSection(foldersVm)} ${appearanceSection()} ${appLockSection()} ${helpSection()}
      ${advancedSection()}
    </div>
  `;
}

export function settingsView() {
  void refreshAppLock();
  return watch(foldersActor, (fs) =>
    watch(syncActor, (ss) => bindingsBody(foldersViewModel(fs), syncViewModel(ss))),
  );
}
