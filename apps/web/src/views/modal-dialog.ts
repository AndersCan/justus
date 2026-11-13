/** A sheet as a native modal dialog. Make one callback per sheet module, never one per render:
 *   const sheetModal = modalDialog();
 *   html`<dialog class="ui-sheet-dialog" aria-label=${title} ${ref(sheetModal)}>
 *          <div class="justus-sheet ui-sheet">…<button data-dismiss>Cancel</button>…</div></dialog>`
 * `data-dismiss`: the button Escape and a tap outside the panel press; none, or disabled,
 * means the sheet cannot be dismissed now. `autofocus`: where focus goes when it opens (showModal does it).
 * `returnFocus` names where focus goes on close; the element focused on open otherwise. */
export function modalDialog(returnFocus?: () => Element | undefined): (el?: Element) => void {
  let current: HTMLDialogElement | undefined;
  let opener: HTMLElement | undefined;
  let pressStartedOnDialog = false;

  function dismiss(dialog: HTMLDialogElement) {
    const button = dialog.querySelector("[data-dismiss]");
    if (button instanceof HTMLButtonElement) button.click();
  }

  function onCancel(e: Event) {
    e.preventDefault();
    if (e.currentTarget instanceof HTMLDialogElement) dismiss(e.currentTarget);
  }
  function onPointerDown(e: Event) {
    pressStartedOnDialog = e.target === e.currentTarget;
  }
  function onClick(e: Event) {
    const started = pressStartedOnDialog;
    pressStartedOnDialog = false;
    if (started && e.target === e.currentTarget && e.currentTarget instanceof HTMLDialogElement) {
      dismiss(e.currentTarget);
    }
  }

  function open(dialog: HTMLDialogElement) {
    if (current !== dialog || !dialog.isConnected || dialog.open) return;
    dialog.showModal();
    // Browsers focus it already; happy-dom does not.
    const first = dialog.querySelector("[autofocus]");
    if (first instanceof HTMLElement && !dialog.contains(document.activeElement)) first.focus();
  }

  function close(dialog: HTMLDialogElement) {
    // Toasts shown in the sheet stay on screen after it goes.
    const toasts = dialog.querySelector("[data-toast-host]");
    if (toasts) document.body.appendChild(toasts);
    if (dialog.open) dialog.close();
    const back = returnFocus?.() ?? opener;
    queueMicrotask(() => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    });
  }

  return (el) => {
    if (el === undefined) {
      if (current) close(current);
      current = undefined;
      return;
    }
    if (!(el instanceof HTMLDialogElement) || el === current) return;
    current = el;
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : undefined;
    el.addEventListener("cancel", onCancel);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("click", onClick);
    // lit hands over the element before it is in the page.
    queueMicrotask(() => open(el));
  };
}
