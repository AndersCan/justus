// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { html, render } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { modalDialog } from "./modal-dialog";
import { toast } from "./toast";

const tick = () => new Promise((r) => setTimeout(r, 0));

function sheet(
  host: HTMLElement,
  cb: (el?: Element) => void,
  onDismiss: () => void,
  disabled = false,
) {
  render(
    html`<dialog aria-label="Sheet" ${ref(cb)}>
      <div><button data-dismiss ?disabled=${disabled} @click=${onDismiss}>Cancel</button></div>
    </dialog>`,
    host,
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("modalDialog", () => {
  it("closes before lit removes it and puts focus back on the opener", async () => {
    const opener = document.body.appendChild(document.createElement("button"));
    opener.focus();
    const host = document.body.appendChild(document.createElement("div"));
    const cb = modalDialog();
    sheet(host, cb, () => {});
    await tick();
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    let wasConnected = false;
    dialog.addEventListener("close", () => (wasConnected = dialog.isConnected));
    render(null, host);
    expect(wasConnected).toBe(true);
    expect(dialog.open).toBe(false);
    await tick();
    expect(document.activeElement).toBe(opener);
  });

  it("Escape presses the dismiss button", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    let pressed = 0;
    sheet(host, modalDialog(), () => pressed++);
    await tick();
    const cancel = new Event("cancel", { cancelable: true });
    host.querySelector("dialog")!.dispatchEvent(cancel);
    expect(pressed).toBe(1);
    expect(cancel.defaultPrevented).toBe(true);
  });

  it("Escape does nothing while the dismiss button is disabled", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    let pressed = 0;
    sheet(host, modalDialog(), () => pressed++, true);
    await tick();
    host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(pressed).toBe(0);
  });

  it("a tap on the dim area dismisses", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    let pressed = 0;
    sheet(host, modalDialog(), () => pressed++);
    await tick();
    const dialog = host.querySelector("dialog")!;
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    dialog.dispatchEvent(new Event("click", { bubbles: true }));
    expect(pressed).toBe(1);
  });

  it("a press that starts in the panel and ends outside keeps it open", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    let pressed = 0;
    sheet(host, modalDialog(), () => pressed++);
    await tick();
    const dialog = host.querySelector("dialog")!;
    dialog.querySelector("div")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    dialog.dispatchEvent(new Event("click", { bubbles: true }));
    expect(pressed).toBe(0);
  });

  it("a toast shown while a sheet is open is inside the sheet, and stays after it closes", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    sheet(host, modalDialog(), () => {});
    await tick();
    const dialog = host.querySelector("dialog")!;
    toast("Asked Kari to join");
    expect(dialog.querySelector("[data-toast-host]")?.textContent).toContain("Asked Kari");
    render(null, host);
    expect(document.body.querySelector("[data-toast-host]")?.textContent).toContain("Asked Kari");
  });

  it("a toast host made before the sheet opened moves into the sheet for the next toast", async () => {
    toast("Saved");
    expect(document.body.querySelector(":scope > [data-toast-host]")).not.toBeNull();
    const host = document.body.appendChild(document.createElement("div"));
    sheet(host, modalDialog(), () => {});
    await tick();
    const dialog = host.querySelector("dialog")!;
    toast("Asked Kari to join");
    expect(dialog.querySelector("[data-toast-host]")?.textContent).toContain("Asked Kari");
  });

  it("returnFocus names where focus goes on close, over the opener", async () => {
    const opener = document.body.appendChild(document.createElement("button"));
    const other = document.body.appendChild(document.createElement("button"));
    opener.focus();
    const host = document.body.appendChild(document.createElement("div"));
    sheet(
      host,
      modalDialog(() => other),
      () => {},
    );
    await tick();
    render(null, host);
    await tick();
    expect(document.activeElement).toBe(other);
  });
});
