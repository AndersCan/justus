import { html, nothing } from "lit-html";
import { t } from "../copy/copy";
import { prefs } from "../machines/prefs-machine";
import { takenMonthOf, type PhotoGroup } from "../utils/photo-scope";

/** Scrolls to a month heading and focuses it, once the list shows it. */
export function revealGroup(label: string): void {
  const heading = [...document.querySelectorAll<HTMLElement>("h2[data-photo-group]")].find(
    (el) => el.dataset.photoGroup === label,
  );
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
}

/** Under a group in Date added: "4 taken in July 2026". Shows that month by date taken, unsaved. */
export function takenMonthLine(group: PhotoGroup) {
  const taken = takenMonthOf(group.photos);
  if (!taken) return nothing;
  const jump = () => {
    prefs.showSortForNow("taken");
    revealGroup(taken.month);
  };
  return html`<button type="button" class="ui-btn-ghost mb-2" @click=${jump}>
    ${t("gallery.taken_in_month", { count: taken.count, month: taken.month })}
  </button>`;
}
