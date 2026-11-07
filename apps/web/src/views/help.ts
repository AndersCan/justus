import { html } from "lit-html";
import { pathFor } from "../machines/router-machine";

export const HELP_QA: { q: string; a: string[] }[] = [
  {
    q: "What is Justus?",
    a: [
      "Justus is a photo sharing app that shares files peer to peer.",
      "What is peer to peer? Most photo apps upload your pictures to a company's servers, and everyone else downloads them from there. With peer to peer, there is no server in the middle. Your photos go straight from your phone to the phones of the people you share the album with.",
      "That means no company, including us, ever gets a copy of your photos. It also means photos only travel while both phones have Justus open and can reach each other. If a friend's phone is off, their new photos show up the next time you both have Justus open.",
    ],
  },
  {
    q: "Why don't I see my friend's new photos?",
    a: [
      "Photos only travel while both phones have Justus open and can reach each other. If your friend's phone is off or Justus is closed, their new photos will show up the next time you both have Justus open.",
      "To check, open the album and tap Invite & members. It shows who is connected right now and when everyone else was last seen.",
    ],
  },
  {
    q: "Do I need WiFi?",
    a: [
      "No, but it helps. Two phones that are both on mobile networks often can't find each other, because of how mobile networks work. If you can't connect, try switching one of the phones to WiFi.",
      "Justus suggests this after about 30 seconds without a connection.",
    ],
  },
  {
    q: "What if I lose my phone?",
    a: [
      "Your photos are stored on the phones in the album, not in the cloud. A phone only has the photos it has received, so a photo is safe once at least one other phone has received it. Photos that only existed on the lost phone are gone.",
      "On a new phone, join the album again with its invite link.",
      "If the lost phone belonged to the Admin, nobody new can be approved. Everyone already in the album keeps their photos and keeps getting new ones. Passing the Admin role to someone else isn't possible yet.",
    ],
  },
  {
    q: "Is Justus a backup?",
    a: [
      "No. Justus shares photos between phones. A photo is safe once at least one other phone has it, but Justus is not made to keep a copy of your whole library. Keep your own backup too.",
    ],
  },
  {
    q: "Who can see an album?",
    a: [
      "Only the people in the album. An invite link on its own shows no photos: the person asks to join, and they see the album's photos, older ones included, only after the Admin accepts them. Links can be set to end, and the Admin can turn off the links they sent.",
      "Removing someone stops them adding photos. Their phone still has the album, so it can keep getting new photos for now. To be sure someone is out, start a new album and invite everyone else again.",
    ],
  },
  {
    q: "What can the Admin see and do?",
    a: [
      "The Admin is the person who started the album. They decide who joins, and they can remove members.",
      "They can't see anything the other members can't. Everyone in an album sees all of its photos, including older ones, and can see who is connected.",
    ],
  },
  {
    q: "Who can remove a photo?",
    a: [
      "Whoever added a photo can remove it, and so can the Admin. Collaborators can't remove other people's photos, and Viewers can't remove anything.",
      "Removing your own photo removes it from the album for everyone. Phones that already have it may keep a copy. When the Admin removes someone else's photo, it is hidden from the album for everyone, and it stays on that person's phone.",
    ],
  },
];

/** The Help destination: a short FAQ, starting with what peer to peer means. */
export function helpView() {
  return html`
    <div class="mx-auto max-w-2xl space-y-6">
      <a class="text-sm text-muted hover:text-fg" href=${pathFor("settings")}>← Settings</a>
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Help</h1>

      <section class="space-y-2" aria-label="Frequently asked questions">
        ${HELP_QA.map(
          (item) => html`<details class="ui-card p-4">
            <summary class="ui-focus cursor-pointer select-none text-sm font-medium text-fg">
              ${item.q}
            </summary>
            <div class="mt-2 space-y-2 text-sm text-fg">
              ${item.a.map((p) => html`<p>${p}</p>`)}
            </div>
          </details>`,
        )}
      </section>
    </div>
  `;
}
