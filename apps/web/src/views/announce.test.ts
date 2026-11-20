// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "lit-html";
import { announce, statusRegion } from "./announce";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const frames = () =>
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });

describe("announce", () => {
  it("writes the text to the status line as text, not markup", () => {
    frames();
    render(statusRegion(), document.body.appendChild(document.createElement("div")));
    announce("<b>Ben</b>, Phone off");
    const line = document.querySelector("[data-announce]");
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.textContent).toBe("<b>Ben</b>, Phone off");
    expect(line?.querySelector("b")).toBeNull();
  });
  it("drops the message when the page has no status line", () => {
    frames();
    expect(() => announce("Ben, Phone off")).not.toThrow();
    expect(document.body.textContent).toBe("");
  });
  it("empties the line first and writes in the next frame, so the same text is read again", () => {
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => queued.push(cb));
    render(statusRegion(), document.body.appendChild(document.createElement("div")));
    const line = document.querySelector("[data-announce]");
    announce("Ben, Phone off");
    queued.shift()?.(0);
    announce("Ben, Phone off");
    expect(line?.textContent).toBe("");
    queued.shift()?.(0);
    expect(line?.textContent).toBe("Ben, Phone off");
  });
});
