import { createGenerator } from "unocss";
import { describe, expect, test } from "vite-plus/test";
import config from "../../uno.config";

const background = (css: string, cls: string) =>
  new RegExp(`\\.${cls}\\{[^}]*background-color:rgb\\(var\\(--([a-z-]+)\\)`).exec(css)?.[1];

describe("request card look", () => {
  test("the card is not the grey of its secondary buttons, so Decline shows as a button", async () => {
    const uno = await createGenerator(config);
    const { css } = await uno.generate(
      '<li class="ui-request-card"><button class="ui-btn-ghost">',
      {
        preflights: false,
      },
    );
    expect(background(css, "ui-btn-ghost")).toBe("subtle");
    expect(background(css, "ui-request-card")).toBe("surface");
    expect(css).toMatch(/\.ui-request-card\{[^}]*border-width:1px/);
  });
});
