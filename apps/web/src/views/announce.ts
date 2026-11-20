import { html, type TemplateResult } from "lit-html";

/** The empty status line `announce` writes to. One, in the app shell's parent, outside the inert shell. */
export function statusRegion(): TemplateResult {
  return html`<p data-announce role="status" class="sr-only"></p>`;
}

/** Says `text` once to a screen reader, never drawn. Only for changes the person did not cause and is not looking at.
 * With no status line (node, or a page without one) the message is dropped. */
export function announce(text: string): void {
  if (typeof document === "undefined") return;
  const line = document.querySelector("[data-announce]");
  if (!line) return;
  line.textContent = "";
  requestAnimationFrame(() => {
    line.textContent = text;
  });
}
