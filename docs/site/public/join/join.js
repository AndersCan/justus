// @ts-check
// Reads the invite link after the "#". apps/web/src/utils/invite-link.ts builds it and
// scripts/join-page.test.ts pins the two together: change one, change the other.

const HEX64 = /^[0-9a-f]{64}$/i;

/** @typedef {{ state: "showingInvitePage", target: string, album: string, owner: string }
 *   | { state: "showingPageWithoutKey" }} InvitePage */

/**
 * @param {string} hash location.hash, with or without "#"
 * @returns {InvitePage}
 */
export function readInvitePage(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get("i");
  const owner = params.get("o");
  if (code === null || owner === null || !HEX64.test(code) || !HEX64.test(owner)) {
    return { state: "showingPageWithoutKey" };
  }
  const end = params.get("e");
  const album = (params.get("n") ?? "").trim();
  const name = (params.get("a") ?? "").trim();
  const target = new URLSearchParams({
    i: code.toLowerCase(),
    o: owner.toLowerCase(),
    ...(end === null ? {} : { e: end }),
    n: album,
    a: name,
  });
  return {
    state: "showingInvitePage",
    target: `justus://join?${target}`,
    album: album === "" ? "this album" : album,
    owner: name,
  };
}

/**
 * @param {Document} doc
 * @param {InvitePage} page
 */
export function showInvitePage(doc, page) {
  if (page.state !== "showingInvitePage") return;
  const who = page.owner === "" ? "the person who invited you" : page.owner;
  const heading = doc.getElementById("heading");
  const open = doc.getElementById("open");
  const after = doc.getElementById("after-open");
  if (!heading || !open || !after) return;
  heading.textContent =
    page.owner === ""
      ? `Someone invited you to “${page.album}”`
      : `${page.owner} invited you to “${page.album}”`;
  open.setAttribute("href", page.target);
  open.hidden = false;
  after.textContent = "Nothing happened? Justus isn't on this phone yet. Get it below.";
  for (const el of doc.querySelectorAll(".owner")) el.textContent = who;
}

if (typeof document !== "undefined") showInvitePage(document, readInvitePage(location.hash));
