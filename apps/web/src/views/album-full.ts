import { html, nothing, type TemplateResult } from "lit-html";

export type AlbumFullProps = {
  back: string;
  name: string;
  role?: string;
  menu: TemplateResult;
  about: TemplateResult;
  actions: TemplateResult;
  problem: TemplateResult;
  requests: TemplateResult;
  invite: TemplateResult;
  members: TemplateResult;
  advanced: TemplateResult;
  sheets: TemplateResult;
};

function roleBadge(role: string | undefined): TemplateResult | typeof nothing {
  if (role === undefined) return nothing;
  return html`<span class="rounded-full bg-subtle px-2.5 py-1 text-xs font-semibold text-fg"
    >${role}</span
  >`;
}

/** The album page frame: back link, title row with role and menu, then each section in order. */
export function renderAlbumFull(props: AlbumFullProps): TemplateResult {
  return html`<div class="flex flex-col gap-5 max-w-2xl">
    <a class="self-start text-sm text-muted hover:text-fg" href="/sharing">${props.back}</a>
    <div class="flex items-center justify-between gap-3">
      <h1
        class="min-w-0 truncate text-2xl font-semibold tracking-tight text-fg outline-none"
        tabindex="-1"
      >
        ${props.name}
      </h1>
      <div class="flex shrink-0 items-center gap-1">
        ${roleBadge(props.role)}
        <div class="contents">${props.menu}</div>
      </div>
    </div>
    <div class="contents">${props.about}</div>
    <div class="contents">${props.actions}</div>
    <div class="contents">${props.problem}</div>
    <div class="contents">${props.requests}</div>
    <div class="contents">${props.invite}</div>
    <div class="contents">${props.members}</div>
    <div class="contents">${props.advanced}</div>
    <div class="contents">${props.sheets}</div>
  </div>`;
}
