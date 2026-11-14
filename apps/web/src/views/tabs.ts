import { html } from "lit-html";

import { copy } from "../copy/copy";
export type TabItem = {
  id: string;
  label: string;
  href: string;
  /** Small count pill (e.g. requests waiting); hidden when 0 or unset. */
  badge?: number;
};

/** Route-backed tabs: each tab is a link, so Back, deep links and reloads land
 * on the same tab. The current one carries `aria-current="page"`. */
export function tabs(label: string, items: TabItem[], activeId: string) {
  return html`<nav class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label=${label}>
    <div class="ui-tabs">
      ${items.map((item) => {
        const active = item.id === activeId;
        return html`<a
          class=${active ? "ui-tab-selected" : "ui-tab"}
          href=${item.href}
          aria-current=${active ? "page" : undefined}
          >${item.label}${
            item.badge
              ? html`<span
                  class="ui-tab-badge"
                  aria-label=${copy("tabs.waiting", { badge: item.badge })}
                  >${item.badge}</span
                >`
              : null
          }</a
        >`;
      })}
    </div>
  </nav>`;
}
