import { html } from "lit-html";
import { atom } from "nanostores";
import { $syncState, $syncViewModel, sync, type SyncStateName } from "../machines/sync-machine";
import { $router } from "../router";
import { useStore } from "../use-store";
import { errorBanner } from "./error-banner";
import { toast } from "./toast";

/** Group a 64-char hex key as "8 groups of 8" — readable, copyable. */
function groupKey(key: string): string {
  return key.replace(/(.{8})/g, "$1 ").trim();
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

const $copied = atom(false);
const $pasteError = atom(false);
const $joinProgress = atom(false);

// Navigate to the gallery once a join lands (joining → ok) — the folder's
// photos then appear without the user hunting for them. Enroll lands a toast.
let seenJoin: SyncStateName | null = null;
let seenEnroll: SyncStateName | null = null;
$syncState.listen((state) => {
  if (seenJoin === "joining" && state === "ok") {
    toast("You're in — photos are syncing");
    $router.open("/", true);
  }
  if (seenEnroll === "enrolling" && state === "ok") {
    toast("That device can add photos now");
  }
  seenJoin = state;
  seenEnroll = state;
  $joinProgress.set(state === "joining");
});

type SyncViewModel = ReturnType<typeof $syncViewModel.get>;

async function shareKey(status: { shareKey: string }) {
  const text = `Join my Justus folder: ${status.shareKey}`;
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Justus folder", text });
      return;
    } catch {
      // share dismissed/failed — fall through to copy
    }
  }
  const ok = await copyText(status.shareKey);
  $copied.set(true);
  setTimeout(() => $copied.set(false), 2000);
  toast(ok ? "Share key copied" : "Couldn't copy — the key is shown above");
}

async function pasteKey(input: HTMLInputElement) {
  try {
    const text = await navigator.clipboard.readText();
    const key = text.trim().replace(/\s+/g, "");
    input.value = key;
    $pasteError.set(key.length > 0 && !/^[0-9a-f]{64}$/i.test(key));
  } catch {
    $pasteError.set(true);
  }
}

function rolePill(role: string) {
  const dot = role === "creator" ? "bg-clay" : role === "member" ? "bg-moss" : "bg-honey";
  return html`<span
    class="inline-flex items-center gap-1.5 rounded-full bg-butter px-2.5 py-1 text-xs font-semibold text-cocoa"
  >
    <span class="h-2 w-2 rounded-full ${dot}"></span>
    ${role}
  </span>`;
}

function inviteSection(status: NonNullable<SyncViewModel["status"]>) {
  const intro =
    status.role === "creator"
      ? "Share the key, then add the device as a writer. Devices can also join as read-only with just the key."
      : "Share this key so other devices can read this folder too.";
  return html`
    <section class="warm-card p-5">
      <h2 class="warm-label mb-1">Invite another device</h2>
      <p class="mb-4 text-sm text-cocoa">${intro}</p>
      <div
        class="rounded-2xl bg-butter px-4 py-3 text-[11px] leading-relaxed font-mono tracking-widest text-ink"
      >
        ${groupKey(status.shareKey)}
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        ${useStore(
          $copied,
          (copied) => html`<button class="warm-pill" @click=${() => void shareKey(status)}>
            ${copied ? "Copied ✓" : "Copy share key"}
          </button>`,
        )}
        ${
          typeof navigator.share === "function"
            ? html`<button class="warm-ghost" @click=${() => void shareKey(status)}>Share…</button>`
            : null
        }
      </div>
    </section>
  `;
}

function enrollSection(status: NonNullable<SyncViewModel["status"]>, state: string, busy: boolean) {
  if (status.role !== "creator") {
    return html`<section class="warm-card p-5">
      <h2 class="warm-label mb-1">Enroll a writer</h2>
      <p class="text-sm text-cocoa">Only the folder's creator can enroll writers.</p>
    </section>`;
  }
  return html`
    <section class="warm-card p-5">
      <h2 class="warm-label mb-1">Enroll a writer</h2>
      <p class="mb-3 text-sm text-cocoa">
        Add a device as a writer: paste its drive key and a name for it.
      </p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const form = e.target as HTMLFormElement;
          const key = (form.querySelector("[data-k]") as HTMLInputElement | null)?.value.trim();
          const name = (form.querySelector("[data-n]") as HTMLInputElement | null)?.value.trim();
          if (key && name) sync.enroll(key, name);
        }}
      >
        <input
          class="warm-input flex-1"
          placeholder="device drive key (hex)"
          aria-label="Device drive key"
          data-k
          spellcheck="false"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
        />
        <input
          class="warm-input w-full sm:w-40"
          placeholder="device name"
          aria-label="Device name"
          data-n
        />
        <button class="warm-ghost" type="submit" ?disabled=${busy || state !== "ok"}>Enroll</button>
      </form>
    </section>
  `;
}

function joinSection(state: string, busy: boolean) {
  return html`
    <section class="warm-card p-5">
      <h2 class="warm-label mb-1">Join a folder</h2>
      <p class="mb-3 text-sm text-cocoa">
        Paste a share key to read (and seed) someone else's folder. You join as a writer if the
        creator enrolled this device.
      </p>
      <form
        class="flex flex-col gap-2 sm:flex-row"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
          const key = input.value.trim().replace(/\s+/g, "");
          if (!/^[0-9a-f]{64}$/i.test(key)) {
            $pasteError.set(true);
            return;
          }
          $pasteError.set(false);
          sync.join(key);
        }}
      >
        <input
          class="warm-input flex-1"
          placeholder="64-char hex share key"
          aria-label="Share key"
          spellcheck="false"
          autocapitalize="none"
          autocomplete="off"
          autocorrect="off"
          @input=${() => $pasteError.set(false)}
        />
        <div class="flex gap-2">
          <button
            class="warm-ghost flex-1"
            type="button"
            aria-label="Paste from clipboard"
            @click=${(e: Event) => {
              const form = (e.currentTarget as HTMLButtonElement).closest("form");
              const input = form?.querySelector("input");
              if (input) void pasteKey(input as HTMLInputElement);
            }}
          >
            Paste
          </button>
          ${useStore(
            $joinProgress,
            (joining) => html`<button
              class="warm-pill flex-1"
              type="submit"
              ?disabled=${busy || state !== "ok" || joining}
            >
              ${joining ? "Joining…" : "Join"}
            </button>`,
          )}
        </div>
      </form>
      ${useStore($pasteError, (err) =>
        err
          ? html`<p class="mt-2 text-xs text-brick">
              That key doesn't look right — check you copied it whole (64 hex chars).
            </p>`
          : null,
      )}
      ${useStore($joinProgress, (joining) =>
        joining
          ? html`<p class="mt-3 flex items-center gap-2 text-sm text-cocoa">
              <span
                class="h-2 w-2 animate-pulse rounded-full bg-honey motion-reduce:animate-none"
              ></span>
              Connecting to the folder…
            </p>`
          : null,
      )}
      <p class="mt-3 text-xs text-taupe">Joining a new folder swaps the one on this device.</p>
    </section>
  `;
}

function deviceSection(status: NonNullable<SyncViewModel["status"]>) {
  return html`
    <section class="warm-card p-5">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="warm-label">Your device</h2>
        ${rolePill(status.role)}
      </div>
      <dl class="grid grid-cols-2 gap-y-2 text-sm">
        <dt class="text-taupe">Device</dt>
        <dd>${status.name}</dd>
        <dt class="text-taupe">Peers</dt>
        <dd>${status.peers}</dd>
        <dt class="text-taupe">Photos</dt>
        <dd>${status.photos}</dd>
        <dt class="text-taupe">Members</dt>
        <dd>${status.members.length}</dd>
      </dl>
      <details class="mt-3 text-xs text-taupe">
        <summary class="cursor-pointer select-none">Advanced</summary>
        <dl class="mt-2 space-y-1 break-all font-mono">
          <dt>Drive key</dt>
          <dd>${status.driveKey}</dd>
          <dt>Discovery key</dt>
          <dd>${status.discoveryKey}</dd>
          <dt>Share key</dt>
          <dd>${status.shareKey}</dd>
        </dl>
      </details>
    </section>
  `;
}

function syncBody(view: SyncViewModel) {
  const { status, state, busy, error, fatal } = view;
  return html`
    <div class="max-w-2xl space-y-5">
      <h1 class="font-serif text-3xl text-ink">Folder</h1>

      ${errorBanner(
        error,
        state === "error" && !fatal ? () => sync.retry() : undefined,
        fatal ? () => window.location.reload() : undefined,
      )}
      ${
        state === "idle" || state === "refreshing"
          ? html`<p class="text-taupe">Loading…</p>`
          : !status
            ? html`
                <p class="text-cocoa">This device isn't sharing a folder yet.</p>
                ${joinSection(state, busy)}
              `
            : html`
                ${inviteSection(status)} ${enrollSection(status, state, busy)}
                ${joinSection(state, busy)} ${deviceSection(status)}
              `
      }
    </div>
  `;
}

export function settingsView() {
  return useStore($syncViewModel, (vm) => syncBody(vm));
}
