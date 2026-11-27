import { expect, test } from "vite-plus/test";
import { isScreenFileName, screenFileName, themesFor } from "./screen-file-name.ts";

test("one theme names each file by its walk position and screen", () => {
  const names = [
    screenFileName("welcome-card-1", { position: 1, theme: "light", themeChoice: "light" }),
    screenFileName("page-not-found", { position: 18, theme: "dark", themeChoice: "dark" }),
  ];
  expect(names).toEqual(["001-welcome-card-1.png", "018-page-not-found.png"]);
});

test("both themes keep the twins side by side and name the theme", () => {
  const names = themesFor("both").map((theme) =>
    screenFileName("settings", { position: 16, theme, themeChoice: "both" }),
  );
  expect(names).toEqual(["016-settings-light.png", "016-settings-dark.png"]);
});

test("file names sort in walk order past nine screens", () => {
  const names = [10, 2, 1].map((position) =>
    screenFileName("help", { position, theme: "light", themeChoice: "light" }),
  );
  expect(names.toSorted()).toEqual(["001-help.png", "002-help.png", "010-help.png"]);
});

test("only the files a run writes count as old shots", () => {
  const files = ["003-help-dark.png", "notes.md", "photo.png", "003-help.png.bak"];
  expect(files.filter((file) => isScreenFileName(file))).toEqual(["003-help-dark.png"]);
});
