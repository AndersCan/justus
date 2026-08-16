import { html } from "lit-html";
import { $requestsViewModel, requests } from "../machines/requests-machine";
import { $syncState, type SyncStateName } from "../machines/sync-machine";
import { useStore } from "../use-store";
import { errorBanner } from "./error-banner";
import { toast } from "./toast";

// Refresh the inbox when the folder state turns over (a join or an approval
// event can change pending requests). Push-driven refreshes are handled in
// main.ts; this catches the local action paths (join/respond) too.
let seen: SyncStateName | null = null;
$syncState.listen((state) => {
  if (seen && state !== seen) requests.refresh();
  seen = state;
});

type RequestsViewModel = ReturnType<typeof $requestsViewModel.get>;

function requestRow(view: RequestsViewModel, responderKey: string) {
  const r = view.requests.find((q) => q.requesterKey === responderKey);
  if (!r) return null;
  return html`
    <li class="warm-card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="font-serif text-lg text-ink">
          <span class="font-semibold">“${r.requesterName}”</span> wants to join
          <span class="font-semibold">“${r.folderName}”</span>
        </p>
        <p class="mt-1 text-sm text-taupe">Wants to add photos to this folder.</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <button
          class="warm-ghost"
          ?disabled=${view.responding}
          @click=${() => requests.respond(r.folderId, r.requesterKey, false)}
        >
          No
        </button>
        <button
          class="warm-pill"
          ?disabled=${view.responding}
          @click=${() => {
            requests.respond(r.folderId, r.requesterKey, true);
            toast(`${r.requesterName} can add photos now`);
          }}
        >
          Yes
        </button>
      </div>
    </li>
  `;
}

function requestsBody(view: RequestsViewModel) {
  const { state, error, fatal } = view;
  return html`
    <div class="max-w-2xl space-y-5">
      <div class="flex items-center justify-between">
        <h1 class="font-serif text-3xl text-ink">Requests</h1>
        <button
          class="warm-ghost"
          ?disabled=${state === "refreshing" || state === "responding"}
          @click=${() => requests.refresh()}
        >
          ${state === "refreshing" ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      ${errorBanner(
        error,
        state === "error" && !fatal ? () => requests.retry() : undefined,
        fatal ? () => window.location.reload() : undefined,
      )}
      ${
        state === "idle" || (state === "refreshing" && view.requests.length === 0)
          ? html`<p class="text-taupe">Loading…</p>`
          : view.requests.length === 0
            ? html`
                <div class="warm-card p-5 text-center">
                  <p class="font-serif text-lg text-ink">No pending requests.</p>
                  <p class="mt-1 text-sm text-cocoa">
                    When someone wants to join one of your folders, their request shows up here.
                  </p>
                </div>
              `
            : html`<ul class="space-y-3">
                ${view.requests.map((q) => requestRow(view, q.requesterKey))}
              </ul>`
      }
    </div>
  `;
}

export function requestsView() {
  return useStore($requestsViewModel, (vm) => requestsBody(vm));
}
