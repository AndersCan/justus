import { html } from "lit-html";
import { $syncBusy, $syncError, $syncState, $syncStatus, sync } from "../machines/sync-machine";
import { useStore } from "../use-store";

async function copyKey(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard unavailable — the value is visible to copy manually.
  }
}

export function settingsView() {
  const status = useStore($syncStatus);
  const state = useStore($syncState);
  const busy = useStore($syncBusy);
  const error = useStore($syncError);

  return html`
    <div class="max-w-xl space-y-6">
      <h1 class="text-2xl font-semibold">Sync</h1>

      ${
        error
          ? html`<div
              class="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300"
            >
              ${error}
              ${
                state === "error"
                  ? html`<button class="ml-2 underline" @click=${() => sync.retry()}>Retry</button>`
                  : null
              }
            </div>`
          : null
      }

      <section class="rounded-lg border border-zinc-800 p-4">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-400">This device</h2>
          <button
            class="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
            ?disabled=${busy || state === "refreshing"}
            @click=${() => sync.refresh()}
          >
            Refresh
          </button>
        </div>
        ${
          state === "idle" || state === "refreshing"
            ? html`<p class="text-zinc-400">Loading status…</p>`
            : !status
              ? html`<p class="text-zinc-400">No status.</p>`
              : html`
                  <dl class="grid grid-cols-2 gap-y-2 text-sm">
                    <dt class="text-zinc-400">Role</dt>
                    <dd>
                      <span
                        class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs uppercase ${
                          status.role === "creator"
                            ? "text-emerald-400"
                            : status.role === "member"
                              ? "text-blue-400"
                              : "text-amber-400"
                        }"
                        >${status.role}</span
                      >
                    </dd>
                    <dt class="text-zinc-400">Device</dt>
                    <dd>${status.name}</dd>
                    <dt class="text-zinc-400">Peers</dt>
                    <dd>${status.peers}</dd>
                    <dt class="text-zinc-400">Photos</dt>
                    <dd>${status.photos}</dd>
                    <dt class="text-zinc-400">Members</dt>
                    <dd>${status.members.length}</dd>
                    <dt class="text-zinc-400">Share key</dt>
                    <dd class="flex items-center gap-2">
                      <code class="truncate text-xs text-zinc-300">${status.shareKey}</code>
                      <button
                        class="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-xs hover:bg-zinc-800"
                        @click=${() => void copyKey(status.shareKey)}
                      >
                        copy
                      </button>
                    </dd>
                  </dl>
                `
        }
      </section>

      <section class="rounded-lg border border-zinc-800 p-4">
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Join a folder
        </h2>
        <p class="mb-2 text-sm text-zinc-400">
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
            class="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
            placeholder="64-char hex share key"
            aria-label="Share key"
            spellcheck="false"
          />
          <button
            class="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
            type="submit"
            ?disabled=${busy || state === "refreshing"}
          >
            Join
          </button>
        </form>
      </section>

      ${
        status?.role === "creator"
          ? html`
              <section class="rounded-lg border border-zinc-800 p-4">
                <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  Enroll a member
                </h2>
                <p class="mb-2 text-sm text-zinc-400">
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
                    class="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                    placeholder="member drive key (hex)"
                    aria-label="Member drive key"
                    data-k
                    spellcheck="false"
                  />
                  <input
                    class="w-40 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                    placeholder="member name"
                    aria-label="Member name"
                    data-n
                  />
                  <button
                    class="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
                    type="submit"
                    ?disabled=${busy || state === "refreshing"}
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
