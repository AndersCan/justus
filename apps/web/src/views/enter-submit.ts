/** Fields live in a `div[data-fields]`, not a `<form>`: Android's autofill service reads forms and asks Google about them. */
export function onEnter(submit: (root: HTMLElement) => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    submit(e.currentTarget as HTMLElement);
  };
}

export function onPress(submit: (root: HTMLElement) => void) {
  return (e: Event) => {
    const root = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-fields]");
    if (root) submit(root);
  };
}
