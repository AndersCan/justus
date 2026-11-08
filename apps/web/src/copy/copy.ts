import { html, nothing, type TemplateResult } from "lit-html";
import en from "./en.json";

/**
 * The text catalogue. Every sentence, label, toast and error a person reads in
 * the web app lives in `en.json` as `id → { text, status, where, who, screen }`;
 * views name an id and never hold the words. Only the owner moves an entry from
 * "draft" to "approved". Placeholders: `{name}` takes a param; `{n?one:other}`
 * writes `one` when param `n` is 1 and `other` otherwise.
 */

export type CopyId = keyof typeof en;
export type CopyParams = Record<string, string | number>;
export type CopyStatus = "draft" | "approved";

type Entry = { text: string; status: CopyStatus; where: string; who: string; screen: string };

const catalogue = en as Record<CopyId, Entry>;

const PLACEHOLDER = /\{(\w+)(?:\?([^:}]*):([^}]*))?\}/g;

/** Text with its placeholders filled; a missing param leaves the placeholder as written. */
export function fill(text: string, params: CopyParams = {}): string {
  return text.replace(PLACEHOLDER, (whole, name: string, one?: string, other?: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    if (one === undefined) return String(v);
    return Number(v) === 1 ? one : (other ?? "");
  });
}

/** The words for an id, as a string (toasts, aria-labels, titles, state text). */
export function copy(id: CopyId, params?: CopyParams): string {
  return fill(catalogue[id].text, params);
}

/** Dev builds mark text that the owner has not approved yet. */
const showDrafts = import.meta.env.DEV;

/** The words for an id as a lit node: a span that carries `data-copy-id`, and in dev `data-copy-draft`. */
export function t(id: CopyId, params?: CopyParams): TemplateResult {
  const draft = showDrafts && catalogue[id].status === "draft";
  return html`<span data-copy-id=${id} data-copy-draft=${draft ? "" : nothing}
    >${copy(id, params)}</span
  >`;
}
