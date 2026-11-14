// The invite page on the site: reads the link right, loads nothing from other sites, connects nowhere.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildInviteLink, parseInviteLink } from "../apps/web/src/utils/invite-link.ts";
import type { JoinInvite } from "../apps/web/src/utils/invite-link.ts";
// @ts-expect-error plain JS page module
import { readInvitePage } from "../docs/site/public/join/join.js";

const publicDir = join(import.meta.dirname, "../docs/site/public");
const A = "a".repeat(64);
const B = "b".repeat(64);
const ORIGIN = "https://anderscan.github.io/justus/";

describe("readInvitePage", () => {
  it("reads a valid link", () => {
    const page = readInvitePage(`#i=${A}&o=${B}&n=Garden&a=Tom`);
    expect(page).toEqual({
      state: "showingInvitePage",
      target: `justus://join?i=${A}&o=${B}&n=Garden&a=Tom`,
      album: "Garden",
      owner: "Tom",
    });
  });
  it("shows the page without a key when there is no #", () => {
    expect(readInvitePage("")).toEqual({ state: "showingPageWithoutKey" });
  });
  it("shows the page without a key when the code is not hex", () => {
    expect(readInvitePage(`#i=javascript:alert(1)&o=${B}`)).toEqual({
      state: "showingPageWithoutKey",
    });
  });
});

describe("readInvitePage, each field", () => {
  it("refuses an owner that is not hex", () => {
    expect(readInvitePage(`#i=${A}&o=zz`)).toEqual({ state: "showingPageWithoutKey" });
  });
  it("names an album with no name", () => {
    expect(readInvitePage(`#i=${A}&o=${B}`).album).toBe("this album");
  });
});

describe("page and app read the same link", () => {
  const invites: JoinInvite[] = [
    { code: A, owner: B, album: "Garden", ownerName: "Tom" },
    {
      code: A,
      owner: B,
      album: "Trip & #1 + more",
      ownerName: "Åse",
      expiresAt: 1_900_000_000_000,
    },
    { code: A, owner: B, album: "Ünï cødé 🌴", ownerName: "" },
    { code: A, owner: B, album: "  Garden  ", ownerName: " Tom " },
  ];
  for (const inv of invites) {
    it(`agrees on ${inv.album}`, () => {
      const link = buildInviteLink(inv);
      const page = readInvitePage(link.split(/[?#]/)[1]);
      expect(page.state).toBe("showingInvitePage");
      const parsed = parseInviteLink(link);
      expect(parseInviteLink(page.target)).toEqual(parsed);
      if (parsed.kind !== "invite") throw new Error("not an invite");
      expect(page.album).toBe(parsed.invite.album);
      expect(page.owner).toBe(parsed.invite.ownerName);
    });
  }
});

describe("invite page in a browser", () => {
  async function open(hash: string) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const requests: { url: string; headers: string }[] = [];
    const violations: string[] = [];
    await page.exposeFunction("recordViolation", (v: string) => violations.push(v));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as any).recordViolation(e.violatedDirective),
      );
    });
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      requests.push({ url: request.url(), headers: JSON.stringify(request.headers()) });
      if (!request.url().startsWith(ORIGIN)) return route.abort();
      const path = new URL(request.url()).pathname.replace(/^\/justus\//, "");
      const file = join(publicDir, path.endsWith("/") ? `${path}index.html` : path);
      const type = file.endsWith(".js") ? "text/javascript" : "text/html";
      try {
        return await route.fulfill({ body: readFileSync(file), contentType: type });
      } catch {
        return route.fulfill({ status: 404, body: "" });
      }
    });
    await page.goto(`${ORIGIN}join/#${hash}`);
    await page.waitForLoadState("networkidle");
    return { browser, page, requests, violations, dialogs };
  }

  it("shows the album, both sections, and connects nowhere", async () => {
    const { browser, page, requests, violations } = await open(
      `i=${A}&o=${B}&e=${Math.floor(Date.now() / 1000) + 600}&n=Garden&a=Tom`,
    );
    try {
      await expect(page.locator("#heading").textContent()).resolves.toBe(
        "Tom invited you to “Garden”",
      );
      const button = page.getByRole("link", { name: "Open in Justus" });
      expect(await button.isVisible()).toBe(true);
      expect(await button.getAttribute("href")).toMatch(
        new RegExp(`^justus://join\\?i=${A}&o=${B}&e=\\d+&n=Garden&a=Tom$`),
      );
      expect(await page.getByRole("heading", { name: "Get Justus" }).isVisible()).toBe(true);
      expect(await page.locator("#after-open").textContent()).toBe(
        "Nothing happened? Justus isn't on this phone yet. Get it below.",
      );
      expect(await page.locator("ol li").first().textContent()).toContain("ask Tom how to join");
      expect(await page.locator("#open + #accept-line").count()).toBe(1);
      expect(await page.locator("#accept-line").isVisible()).toBe(true);
      expect(await page.locator("#accept-line").textContent()).toBe(
        "Tom will get your request and has to accept it.",
      );
      expect(requests.map((r) => r.url).sort()).toEqual([
        `${ORIGIN}join/`,
        `${ORIGIN}join/join.js`,
      ]);
      for (const r of requests) {
        expect(r.url).not.toContain(A);
        expect(r.headers).not.toContain(A);
      }
      expect(violations).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("writes names as text only", async () => {
    const { browser, page, dialogs } = await open(
      `i=${A}&o=${B}&n=${encodeURIComponent("<img src=x onerror=alert(1)>")}&a=${encodeURIComponent("<img src=x onerror=alert(1)>")}`,
    );
    try {
      expect(await page.locator("#heading").textContent()).toContain(
        "<img src=x onerror=alert(1)>",
      );
      expect(await page.locator("#heading img").count()).toBe(0);
      expect(await page.locator("#accept-line").textContent()).toMatch(
        /^<img src=x onerror=alert\(1\)> will get/,
      );
      expect(await page.locator("#accept-line img").count()).toBe(0);
      expect(dialogs).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("wraps a long name inside the accept line", async () => {
    const { browser, page } = await open(`i=${A}&o=${B}&n=Garden&a=${"Bartholomew".repeat(8)}`);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const sizes = await page.evaluate(() => {
        const line = document.getElementById("accept-line")!;
        return {
          line: line.scrollWidth <= line.clientWidth,
          page: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(sizes).toEqual({ line: true, page: true });
    } finally {
      await browser.close();
    }
  });

  it("hides the button when the key is missing", async () => {
    const { browser, page } = await open(`i=javascript:alert(1)&o=${B}`);
    try {
      expect(await page.locator("#open").isVisible()).toBe(false);
      expect(await page.locator("#open").getAttribute("href")).toBeNull();
      expect(await page.locator("#after-open").textContent()).toContain("missing a part");
      expect(await page.locator("#accept-line").isVisible()).toBe(false);
      expect(await page.locator("#accept-line").textContent()).toBe("");
    } finally {
      await browser.close();
    }
  });
});

describe("invite page without a name", () => {
  it("says Someone and the person who invited you", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) => {
        const path = new URL(route.request().url()).pathname.replace(/^\/justus\//, "");
        const file = join(publicDir, path.endsWith("/") ? `${path}index.html` : path);
        return route.fulfill({
          body: readFileSync(file),
          contentType: file.endsWith(".js") ? "text/javascript" : "text/html",
        });
      });
      await page.goto(`${ORIGIN}join/#i=${A}&o=${B}&n=Garden&a=`);
      await expect(page.locator("#heading").textContent()).resolves.toBe(
        "Someone invited you to “Garden”",
      );
      expect(await page.locator("ol li").first().textContent()).toContain(
        "ask the person who invited you how to join",
      );
      expect(await page.locator("#accept-line").textContent()).toBe(
        "The person who invited you will get your request and has to accept it.",
      );
      await page.goto(`${ORIGIN}join/#i=${A}&o=${B}&n=Garden&a=${encodeURIComponent("$&")}`);
      await page.reload();
      expect(await page.locator("#accept-line").textContent()).toBe(
        "$& will get your request and has to accept it.",
      );
    } finally {
      await browser.close();
    }
  });
});

describe("join page words", () => {
  const en: Record<string, { text: string; status: string }> = JSON.parse(
    readFileSync(join(import.meta.dirname, "../apps/web/src/copy/en.json"), "utf8"),
  );
  const source = readFileSync(join(publicDir, "join/join.js"), "utf8");
  const ids = Object.keys(en).filter((id) => id.startsWith("join_page."));
  it("has at least one entry", () => {
    expect(ids.length).toBeGreaterThan(0);
  });
  for (const id of ids) {
    it(`keeps ${id} equal in join.js`, () => {
      expect(["draft", "approved"]).toContain(en[id].status);
      expect(
        source.includes(JSON.stringify(en[id].text)),
        `join.js must hold the exact text of en.json ${id}; change both`,
      ).toBe(true);
    });
  }
});

describe("index.html", () => {
  const html = readFileSync(join(publicDir, "join/index.html"), "utf8");
  it("pins a CSP that allows only its own script", () => {
    expect(html).toContain(
      `content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"`,
    );
  });
  it("points at no other site", () => {
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
  });
});
