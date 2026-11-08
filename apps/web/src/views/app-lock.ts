import type { LockStatus } from "@justus/core";
import { watch } from "@mantaq/lit";
import { html, nothing } from "lit-html";
import { gateway } from "../gateway";
import { appLockActor, appLockEvents } from "../machines/app-lock-machine";
import { toast } from "./toast";

type Result<T> = Promise<[Error, null] | [null, T]>;
type Load = () => Result<LockStatus>;
type SetEnabled = (enabled: boolean) => Result<{ enabled: boolean }>;

export function isLockStatus(v: unknown): v is LockStatus {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as LockStatus).available === "boolean" &&
    typeof (v as LockStatus).enabled === "boolean"
  );
}

/** Reads the lock status from the Android host. Elsewhere, or on any error, the card stays absent. */
export async function refreshAppLock(load: Load = gateway.lock.status as Load) {
  if ((window as { BareShell?: boolean }).BareShell !== true) return;
  const [err, status] = await load();
  const next = !err && isLockStatus(status) ? status : undefined;
  appLockActor.send(appLockEvents.statusRead.create({ status: next }));
}

export async function toggleAppLock(
  set: SetEnabled = gateway.lock.setEnabled as SetEnabled,
  load: Load = gateway.lock.status as Load,
) {
  const snap = appLockActor.snapshot();
  const status = snap.context.status;
  if (snap.path[0] === "savingLockChoice" || !status) return;
  const want = !status.enabled;
  appLockActor.send(appLockEvents.saveStarted.create());
  const [err, result] = await set(want);
  appLockActor.send(appLockEvents.saveEnded.create({ status }));
  if (err || typeof result?.enabled !== "boolean") {
    toast(`Couldn't turn ${want ? "on" : "off"} App lock. Try again.`);
    await refreshAppLock(load);
    return;
  }
  if (result.enabled === status.enabled) return;
  appLockActor.send(
    appLockEvents.statusRead.create({ status: { ...status, enabled: result.enabled } }),
  );
  toast(result.enabled ? "App lock is on" : "App lock is off");
}

const HINT_AVAILABLE =
  "Uses your phone's fingerprint, face or PIN. Applies after you've been away for 30 seconds.";
const HINT_UNAVAILABLE = "Set a screen lock in your phone's Settings to use App lock.";

/** What the card shows for a state; `undefined` means no card. */
export function appLockView({ status, busy }: { status: LockStatus | undefined; busy: boolean }) {
  if (!status) return undefined;
  return {
    on: status.available && status.enabled,
    disabled: !status.available || busy,
    hint: status.available ? HINT_AVAILABLE : HINT_UNAVAILABLE,
  };
}

export function appLockSection() {
  return watch(appLockActor, (s) => {
    const view = appLockView({ status: s.context.status, busy: s.path[0] === "savingLockChoice" });
    if (!view) return nothing;
    const { on, disabled, hint } = view;
    return html`<section class="ui-card p-5">
      <h2 class="ui-label mb-3">App lock</h2>
      <button
        type="button"
        role="switch"
        aria-checked=${on ? "true" : "false"}
        ?disabled=${disabled}
        class="ui-focus flex w-full items-center justify-between gap-4 rounded-xl px-3 py-2.5 text-left text-sm font-medium ring-1 transition disabled:opacity-50 ${
          on ? "bg-accent/10 text-accent ring-accent" : "bg-subtle text-fg ring-line"
        }"
        @click=${() => void toggleAppLock()}
      >
        <span>Require unlock to open Justus</span>
        <span aria-hidden="true">${on ? "On" : "Off"}</span>
      </button>
      <p class="mt-3 text-sm text-muted">${hint}</p>
    </section>`;
  });
}
