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
import { friends, friendsActor, savedFriends } from "../machines/friends-machine";
import { confirmAction } from "./confirm";
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
      ${avatarBadge(name || "?", picture, "ui-avatar-lg")}
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

async function removeFriend(identity: string, name: string, remove: (identity: string) => void) {
  const ok = await confirmAction({
    title: copy("settings_friends.confirm_title", { name }),
    detail: copy("settings_friends.confirm_detail", { name }),
    confirmLabel: copy("settings_friends.remove"),
    tone: "danger",
  });
  if (ok) remove(identity);
}

export function friendsSection(
  actor: typeof friendsActor = friendsActor,
  remove: (identity: string) => void = friends.remove,
) {
  return watch(actor, (snapshot) => {
    if (snapshot.path[0] === "loadingFriends") return null;
    const rows = savedFriends(snapshot.context.friends);
    const removing = snapshot.path[0] === "removingFriend";
    return html`<section class="ui-card p-5">
      <h2 class="ui-label mb-1">${t("settings_friends.friends")}</h2>
      ${
        rows.length === 0
          ? html`<p class="text-sm text-muted">${t("settings_friends.empty")}</p>`
          : html`<ul class="divide-y divide-line">
              ${rows.map(
                (f) => html`<li class="flex items-center justify-between gap-3 py-2">
                  <span class="min-w-0 break-words text-sm text-fg">${f.name}</span>
                  <button
                    class="ui-btn-ghost"
                    type="button"
                    ?disabled=${removing}
                    aria-label=${copy("settings_friends.remove_label", { name: f.name })}
                    @click=${() => removeFriend(f.identity, f.name, remove)}
                  >
                    ${t("settings_friends.remove")}
                  </button>
                </li>`,
              )}
            </ul>`
      }
    </section>`;
  });
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
      ${profileSection(foldersVm)} ${appearanceSection()} ${appLockSection()} ${friendsSection()}
      ${helpSection()} ${advancedSection()}
    </div>
  `;
}

export function settingsView() {
  void refreshAppLock();
  return watch(foldersActor, (fs) =>
    watch(syncActor, (ss) => bindingsBody(foldersViewModel(fs), syncViewModel(ss))),
  );
}
