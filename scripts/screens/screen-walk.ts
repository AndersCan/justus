import type { Page } from "@playwright/test";

/**
 * Which worklet a screen runs on. A `new` phone has no album and has not seen the intro; a `seeded`
 * phone has the sample album with three photos and has seen the intro.
 */
export type Phone = "new" | "seeded";

export interface Screen {
  name: string;
  phone: Phone;
  endsOn: RegExp;
  open: (page: Page) => Promise<void>;
}

/** The screens in the order a first-time user meets them: the intro, then each tab and its sheets. */
export const screenWalk: readonly Screen[] = [
  { name: "welcome-card-1", phone: "new", endsOn: /^\/welcome$/, open: openWelcome },
  { name: "welcome-card-2", phone: "new", endsOn: /^\/welcome$/, open: openWelcomeCardTwo },
  { name: "welcome-name", phone: "new", endsOn: /^\/welcome$/, open: openWelcomeName },
  { name: "welcome-start", phone: "new", endsOn: /^\/welcome$/, open: openWelcomeStart },
  { name: "photos-all", phone: "seeded", endsOn: /^\/$/, open: openPhotos },
  { name: "photos-date-taken", phone: "seeded", endsOn: /^\/$/, open: openPhotosByDateTaken },
  { name: "photo-open", phone: "seeded", endsOn: /^\/$/, open: openPhoto },
  { name: "photos-added-by-me", phone: "seeded", endsOn: /^\/mine$/, open: openAddedByMe },
  { name: "albums", phone: "seeded", endsOn: /^\/albums$/, open: openAlbums },
  { name: "albums-new-album", phone: "seeded", endsOn: /^\/albums$/, open: openNewAlbum },
  { name: "album-photos", phone: "seeded", endsOn: /^\/albums\/.+/, open: openAlbumPhotos },
  { name: "sharing", phone: "seeded", endsOn: /^\/sharing$/, open: openSharing },
  { name: "sharing-album", phone: "seeded", endsOn: /^\/sharing\/.+/, open: openSharingAlbum },
  {
    name: "sharing-album-more-options",
    phone: "seeded",
    endsOn: /^\/sharing\/.+/,
    open: openSharingAlbumMoreOptions,
  },
  { name: "sharing-join", phone: "seeded", endsOn: /^\/join$/, open: openJoin },
  { name: "settings", phone: "seeded", endsOn: /^\/settings$/, open: openSettings },
  { name: "help", phone: "seeded", endsOn: /^\/help$/, open: openHelp },
  { name: "page-not-found", phone: "seeded", endsOn: /^\/nope$/, open: openMissingPage },
];

async function openWelcome(page: Page): Promise<void> {
  await page.goto("/welcome");
  await page.getByRole("button", { name: "Next" }).waitFor();
}

async function openWelcomeCardTwo(page: Page): Promise<void> {
  await openWelcome(page);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Back" }).waitFor();
}

async function openWelcomeName(page: Page): Promise<void> {
  await openWelcomeCardTwo(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").waitFor();
}

async function openWelcomeStart(page: Page): Promise<void> {
  await openWelcomeName(page);
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Your name").press("Enter");
  await page.getByText("Start sharing").waitFor();
}

async function openPhotos(page: Page): Promise<void> {
  await page.goto("/");
  await firstPhoto(page).waitFor();
}

async function openPhotosByDateTaken(page: Page): Promise<void> {
  await openPhotos(page);
  await page.getByRole("radio", { name: "Date taken" }).click();
  await firstPhoto(page).waitFor();
}

async function openPhoto(page: Page): Promise<void> {
  await openPhotos(page);
  await firstPhoto(page).click();
  await page.getByRole("dialog").waitFor();
}

async function openAddedByMe(page: Page): Promise<void> {
  await page.goto("/mine");
  await firstPhoto(page).waitFor();
}

async function openAlbums(page: Page): Promise<void> {
  await page.goto("/albums");
  await sampleAlbumLink(page).waitFor();
}

async function openNewAlbum(page: Page): Promise<void> {
  await openAlbums(page);
  await page.getByRole("button", { name: /new album/i }).click();
  await page.getByRole("dialog").waitFor();
}

async function openAlbumPhotos(page: Page): Promise<void> {
  await openAlbums(page);
  await sampleAlbumLink(page).click();
  await firstPhoto(page).waitFor();
}

async function openSharing(page: Page): Promise<void> {
  await page.goto("/sharing");
  await membersLink(page).waitFor();
}

async function openSharingAlbum(page: Page): Promise<void> {
  await openSharing(page);
  await membersLink(page).click();
  await page.getByRole("button", { name: "More options" }).waitFor();
}

async function openSharingAlbumMoreOptions(page: Page): Promise<void> {
  await openSharingAlbum(page);
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem").first().waitFor();
}

async function openJoin(page: Page): Promise<void> {
  await page.goto("/join");
  await page.getByRole("button", { name: "Ask to join" }).waitFor();
}

async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("radio", { name: "Auto" }).waitFor();
}

async function openHelp(page: Page): Promise<void> {
  await page.goto("/help");
  await page.getByRole("link", { name: "← Settings" }).waitFor();
}

async function openMissingPage(page: Page): Promise<void> {
  await page.goto("/nope");
  await page.getByText("We couldn't find that page.").waitFor();
}

function firstPhoto(page: Page) {
  return page.getByRole("button", { name: /^View / }).first();
}

function sampleAlbumLink(page: Page) {
  return page.getByRole("link", { name: /^Sample photos/ });
}

function membersLink(page: Page) {
  return page.getByRole("link", { name: "Invite & members of Sample photos" });
}
