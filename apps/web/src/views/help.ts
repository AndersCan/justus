import { html } from "lit-html";

const QA: { q: string; a: string[] }[] = [
  {
    q: "What is Justus?",
    a: [
      "Justus is a photo sharing app that shares files peer to peer.",
      "What is peer to peer? Most photo apps upload your pictures to a company's servers, and everyone else downloads them from there. With peer to peer, there is no server in the middle. Your photos go straight from your phone to the phones of the people you share the album with.",
      "That means no company, including us, ever gets a copy of your photos. It also means photos only travel while both phones have Justus open and can reach each other. If a friend's phone is off, their new photos show up the next time you are both online.",
    ],
  },
  {
    q: "Why don't I see my friend's new photos?",
    a: [
      "Photos only travel while both phones have Justus open and can reach each other. If your friend's phone is off or Justus is closed, their new photos will show up the next time you are both online.",
      "To check, open the People tab. It shows who is connected right now and when everyone else was last seen.",
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
      "Your photos are stored on the phones in the album, not in the cloud. A phone only has the photos it has synced, so a photo is safe if at least one other phone has synced it. Photos that only existed on the lost phone are gone.",
      "On a new phone, ask to join the album again with a new invite.",
      "If the lost phone belonged to the Admin, nobody new can be approved. Everyone already in the album keeps their photos and keeps syncing. Passing the Admin role to someone else isn't possible yet.",
    ],
  },
  {
    q: "Who can see an album?",
    a: [
      "Anyone who has the album's invite can see its photos, even before the Admin approves them. Approval is what lets someone add photos. So send the invite only to the people you want in the album, and don't post it anywhere public.",
      "Removing someone stops them adding photos. If they kept the invite, they can still see new photos for now. To be sure someone is out, start a new album and invite everyone else again.",
    ],
  },
  {
    q: "What can the Admin see and do?",
    a: [
      "The Admin is the person who started the album. They approve who can add photos, and they can remove members.",
      "They can't see anything the other members can't. Everyone in an album sees all of its photos, including older ones, and can see who is connected.",
    ],
  },
];

/** The Help destination: a short FAQ, starting with what peer to peer means. */
export function helpView() {
  return html`
    <div class="mx-auto max-w-2xl space-y-6">
      <h1 class="text-2xl font-semibold tracking-tight text-fg">Help</h1>

      <section class="space-y-2" aria-label="Frequently asked questions">
        ${QA.map(
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
