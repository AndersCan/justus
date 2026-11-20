// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { onEnter, onPress } from "./enter-submit";

function fields() {
  const submit = vi.fn();
  const root = document.createElement("div");
  root.dataset.fields = "";
  root.innerHTML = `<input value="x"><button type="button">go</button>`;
  root.addEventListener("keydown", onEnter(submit));
  root.querySelector("button")?.addEventListener("click", onPress(submit));
  return {
    root,
    submit,
    input: root.querySelector("input")!,
    button: root.querySelector("button")!,
  };
}

test("Enter in an input submits the fields once", () => {
  const { root, submit, input } = fields();
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  expect(submit).toHaveBeenCalledExactlyOnceWith(root);
  expect(ev.defaultPrevented).toBe(true);
});

test("other keys and Enter on a button do not submit", () => {
  const { submit, input, button } = fields();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(submit).not.toHaveBeenCalled();
});

test("pressing the button submits the fields", () => {
  const { root, submit, button } = fields();
  document.body.append(root);
  button.click();
  expect(submit).toHaveBeenCalledExactlyOnceWith(root);
  root.remove();
});

test("a button outside any fields submits nothing", () => {
  const submit = vi.fn();
  const button = document.createElement("button");
  button.addEventListener("click", onPress(submit));
  button.click();
  expect(submit).not.toHaveBeenCalled();
});
