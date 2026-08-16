import { html } from "lit-html";
import type { SyncStatus } from "@justus/core";
import { $syncViewModel, sync } from "../machines/sync-machine";
import { useStore } from "../use-store";

async function copyKey(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard unavailable — the value is visible to copy manually.
  }
}

type SyncViewModel = {
  status: SyncStatus | null;
  state: string;
  busy: boolean;
  error: string | null;
};

function roleBadge(role: SyncStatus["role"]) {
  const tone =
    role === "creator"
      ? "border-lavpur-500/40 bg-lavpur-500/10 text-lavpur-700"
      : role === "member"
        ? "border-gold-500/50 bg-gold-500/15 text-gold-800"
        : "border-coral-500/40 bg-coral-500/10 text-coral-700";
  return html`<span class="chip uppercase ${tone}">${role}</span>`;
}

function syncBody({ status, state, busy, error }: SyncViewModel) {
  const refreshing = state === "refreshing" || state === "idle";
  return html`
    <div class="max-w-2xl space-y-6">
      <div>
        <p class="label mb-1">Folder &amp; devices</p>
        <h1 class="font-display text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
          Sync
        </h1>
        <p class="mt-1.5 max-w-md text-sm text-ink-600">
          How this folder is shared between your devices.
        </p>
      </div>

      ${
        error
          ? html`<div
              class="flex items-start gap-3 rounded-xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-800 shadow-soft"
              role="alert"
            >
              <svg
                class="mt-0.5 h-4 w-4 shrink-0 text-coral-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <div class="min-w-0 flex-1">
                <p>${error}</p>
                ${
                  state === "error"
                    ? html`<button class="btn-link mt-1 text-xs" @click=${() => sync.retry()}>
                        Retry
                      </button>`
                    : null
                }
              </div>
            </div>`
          : null
      }

      <section class="card p-5">
        <div class="mb-4 flex items-center justify-between gap-2">
          <h2 class="label">This device</h2>
          <button
            class="btn-ghost !px-3 !py-1 text-xs"
            ?disabled=${busy || refreshing}
            @click=${() => sync.refresh()}
          >
            ${
              refreshing
                ? html`<span
                    class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-mist-300 border-t-lavpur-600"
                    aria-hidden="true"
                  ></span>`
                : null
            }
            Refresh
          </button>
        </div>
        ${
          refreshing
            ? html`<p class="text-sm text-ink-500">Loading status…</p>`
            : !status
              ? html`<p class="text-sm text-ink-500">No status.</p>`
              : html`
                  <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <dt class="text-ink-500">Role</dt>
                    <dd>${roleBadge(status.role)}</dd>
                    <dt class="text-ink-500">Device</dt>
                    <dd class="font-medium text-ink-900">${status.name}</dd>
                    <dt class="text-ink-500">Peers</dt>
                    <dd class="font-medium text-ink-900">${status.peers}</dd>
                    <dt class="text-ink-500">Photos</dt>
                    <dd class="font-medium text-ink-900">${status.photos}</dd>
                    <dt class="text-ink-500">Members</dt>
                    <dd class="font-medium text-ink-900">${status.members.length}</dd>
                    <dt class="text-ink-500">Share key</dt>
                    <dd class="flex min-w-0 items-center gap-2">
                      <code
                        class="truncate rounded-md bg-mist-100 px-2 py-1 font-mono text-xs text-ink-800"
                        >${status.shareKey}</code
                      >
                      <button
                        class="btn-ghost !rounded-md !px-2 !py-1 text-xs"
                        title="Copy share key"
                        @click=${() => void copyKey(status.shareKey)}
                      >
                        copy
                      </button>
                    </dd>
                  </dl>
                `
        }
      </section>

      <section class="card p-5">
        <h2 class="label mb-2">Join a folder</h2>
        <p class="mb-3 text-sm text-ink-600">
          Paste a share key to read (and seed) someone else's folder. Your device joins as a member
          automatically if the creator enrolled it.
        </p>
        <form
          class="flex gap-2"
          @submit=${(e: SubmitEvent) => {
            e.preventDefault();
            const input = (e.target as HTMLFormElement).querySelector("input");
            if (input?.value.trim()) sync.join(input.value.trim());
          }}
        >
          <input
            class="input font-mono"
            placeholder="64-char hex share key"
            aria-label="Share key"
            spellcheck="false"
          />
          <button class="btn-primary shrink-0" type="submit" ?disabled=${busy || refreshing}>
            Join
          </button>
        </form>
      </section>

      ${
        status?.role === "creator"
          ? html`
              <section class="card p-5">
                <h2 class="label mb-2">Enroll a member</h2>
                <p class="mb-3 text-sm text-ink-600">
                  Add a writer to this folder: paste the member device's drive key and its name.
                </p>
                <form
                  class="flex flex-col gap-2 sm:flex-row"
                  @submit=${(e: SubmitEvent) => {
                    e.preventDefault();
                    const form = e.target as HTMLFormElement;
                    const key = (
                      form.querySelector("[data-k]") as HTMLInputElement | null
                    )?.value.trim();
                    const name = (
                      form.querySelector("[data-n]") as HTMLInputElement | null
                    )?.value.trim();
                    if (key && name) sync.enroll(key, name);
                  }}
                >
                  <input
                    class="input font-mono"
                    placeholder="member drive key (hex)"
                    aria-label="Member drive key"
                    data-k
                    spellcheck="false"
                  />
                  <input
                    class="input sm:max-w-44"
                    placeholder="member name"
                    aria-label="Member name"
                    data-n
                  />
                  <button
                    class="btn-primary shrink-0"
                    type="submit"
                    ?disabled=${busy || refreshing}
                  >
                    Enroll
                  </button>
                </form>
              </section>
            `
          : null
      }
    </div>
  `;
}

export function settingsView() {
  return useStore($syncViewModel, (vm) => syncBody(vm));
}
