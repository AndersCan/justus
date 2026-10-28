import { html } from "lit-html";
import { $foldersViewModel, folders } from "../machines/folders-machine";
import { $syncViewModel, sync } from "../machines/sync-machine";
import { useStore } from "../use-store";
import {
  $profilePicture,
  clearProfilePicture,
  setProfilePictureFromFile,
} from "../utils/profile-picture";
import { avatarBadge } from "./avatar";
import { errorBanner } from "./error-banner";
import { logsPanel } from "./logs";
import { themeSetting } from "./theme-toggle";
import { toast } from "./toast";

type SyncViewModel = ReturnType<typeof $syncViewModel.get>;
type FoldersViewModel = ReturnType<typeof $foldersViewModel.get>;

async function pickPicture(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    if (!(await setProfilePictureFromFile(file))) toast("Couldn't save the picture on this device");
  } catch {
    toast("That file isn't a picture we can read");
  }
}

function pictureRow(name: string) {
  return useStore(
    $profilePicture,
    (picture) => html`<div class="mb-4 flex items-center gap-4">
      ${avatarBadge(name || "?", picture, "h-16 w-16 text-xl")}
      <div class="flex flex-wrap gap-2">
        <label class="ui-btn-ghost cursor-pointer">
          ${picture ? "Change picture" : "Add picture"}
          <input class="sr-only" type="file" accept="image/*" @change=${pickPicture} />
        </label>
        ${
          picture
            ? html`<button class="ui-btn-ghost" type="button" @click=${clearProfilePicture}>
                Remove
              </button>`
            : null
        }
      </div>
    </div>`,
  );
}

function profileSection(view: FoldersViewModel) {
  const saving = view.state === "renaming";
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-1">Profile</h2>
      <p class="mb-4 text-sm text-fg">
        Your name is shown to others as the member behind the photos you add and the join requests
        you send. Your picture stays on this device.
      </p>
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
          placeholder="Your name"
          aria-label="Your name"
          value="${view.userName}"
          spellcheck="false"
          autocomplete="name"
        />
        <button class="ui-btn-primary" type="submit" ?disabled=${saving}>
          ${saving ? "Saving…" : "Save"}
        </button>
      </form>
    </section>
  `;
}

function appearanceSection() {
  return html`
    <section class="ui-card p-5">
      <h2 class="ui-label mb-3">Appearance</h2>
      ${themeSetting()}
    </section>
  `;
}

function advancedSection() {
  return html`<details class="text-xs text-muted">
    <summary class="ui-label cursor-pointer select-none">Advanced</summary>
    <div class="mt-3">${logsPanel()}</div>
  </details>`;
}

function bindingsBody(foldersVm: FoldersViewModel, syncVm: SyncViewModel) {
  const { state, error, fatal } = syncVm;
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Settings</h1>

      ${errorBanner(
        error || foldersVm.error,
        (state === "error" || foldersVm.state === "error") && !fatal && !foldersVm.fatal
          ? () => {
              sync.retry();
              folders.retry();
            }
          : undefined,
        fatal || foldersVm.fatal ? () => window.location.reload() : undefined,
      )}
      ${profileSection(foldersVm)} ${appearanceSection()} ${advancedSection()}
    </div>
  `;
}

export function settingsView() {
  return useStore($foldersViewModel, (foldersVm) =>
    useStore($syncViewModel, (syncVm) => bindingsBody(foldersVm, syncVm)),
  );
}
