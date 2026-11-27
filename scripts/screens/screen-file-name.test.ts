import { expect, test } from "vite-plus/test";
import { isScreenFileName, screenFileName, themesFor } from "./screen-file-name.ts";
import { screenWalk } from "./screen-walk.ts";

test("names each file by its walk position, screen and theme", () => {
  const names = [
    screenFileName("welcome-card-1", { position: 1, theme: "light" }),
    screenFileName("page-not-found", { position: 18, theme: "dark" }),
  ];
  expect(names).toEqual(["001-welcome-card-1-light.png", "018-page-not-found-dark.png"]);
});

test("both themes keep the twins side by side in a folder listing", () => {
  const twins = themesFor("both").map((theme) =>
    screenFileName("settings", { position: 16, theme }),
  );
  const neighbours = [screenFileName("help", { position: 17, theme: "light" }), ...twins];
  expect(neighbours.toSorted()).toEqual([
    "016-settings-dark.png",
    "016-settings-light.png",
    "017-help-light.png",
  ]);
});

test("file names sort in walk order past nine screens", () => {
  const names = [10, 2, 1].map((position) => screenFileName("help", { position, theme: "light" }));
  expect(names.toSorted()).toEqual([
    "001-help-light.png",
    "002-help-light.png",
    "010-help-light.png",
  ]);
});

test("only the files a run writes count as old shots", () => {
  const files = [
    "003-help-dark.png",
    "notes.md",
    "photo.png",
    "003-help.png",
    "003-help-dark.png.bak",
  ];
  expect(files.filter((file) => isScreenFileName(file))).toEqual(["003-help-dark.png"]);
});

test("every screen in the walk gets a name a later run can clear", () => {
  const names = screenWalk.flatMap((screen, index) =>
    themesFor("both").map((theme) => screenFileName(screen.name, { position: index + 1, theme })),
  );
  expect(names.filter((name) => !isScreenFileName(name))).toEqual([]);
});
