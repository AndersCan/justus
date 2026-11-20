// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { prefsMachine, prefs, prefsActor } from "./prefs-machine";

beforeEach(() => {
  localStorage.clear();
});

describe("prefs", () => {
  it("starts from the stored values", () => {
    localStorage.setItem("justus:gallery-density", "compact");
    const a = prefsMachine.create({});
    expect(a.snapshot().context.density).toBe("compact");
    expect(a.snapshot().context.sort).toBe("added");
  });

  it("setDensity writes storage and context", () => {
    prefs.setDensity("compact");
    expect(localStorage.getItem("justus:gallery-density")).toBe("compact");
    expect(prefsActor.snapshot().context.density).toBe("compact");
  });

  it("setSort and setTheme write storage and context", () => {
    prefs.setSort("taken");
    prefs.setTheme("dark");
    expect(localStorage.getItem("justus:photo-sort")).toBe("taken");
    expect(prefsActor.snapshot().context.sort).toBe("taken");
    expect(prefsActor.snapshot().context.theme).toBe("dark");
  });

  it("showSortForNow changes what the screens show and saves nothing", () => {
    prefs.setSort("added");
    localStorage.clear();
    prefs.showSortForNow("taken");
    expect(prefsActor.snapshot().context.sort).toBe("taken");
    expect(localStorage.getItem("justus:photo-sort")).toBeNull();
  });

  it("sets and clears the picture", () => {
    expect(prefs.setPicture("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(prefsActor.snapshot().context.picture).toBe("data:image/jpeg;base64,AAAA");
    expect(prefs.setPicture("")).toBe(true);
    expect(prefsActor.snapshot().context.picture).toBe("");
    expect(localStorage.getItem("justus:profile-picture")).toBeNull();
  });
});
