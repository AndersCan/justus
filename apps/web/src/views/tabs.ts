import { html } from "lit-html";

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
    <div class="inline-flex gap-1 rounded-xl bg-subtle p-1">
      ${items.map((item) => {
        const active = item.id === activeId;
        return html`<a
          class="ui-focus inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition ${
            active ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-muted hover:text-fg"
          }"
          href=${item.href}
          aria-current=${active ? "page" : undefined}
          >${item.label}${
            item.badge
              ? html`<span
                  class="rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-4 text-white"
                  aria-label="${item.badge} waiting"
                  >${item.badge}</span
                >`
              : null
          }</a
        >`;
      })}
    </div>
  </nav>`;
}
