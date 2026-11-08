# Sharing flows: links that expire, accept as Viewer or Collaborator, who can remove photos

Status: proposal for review. Nothing here changes app behaviour yet. Tracked in #78 (sharing) and #79 (removing photos). The machines and walk links are on the Pages site (see Walks).

Words used: **Admin** (code: creator), **Collaborator** (can add photos; code today: member), **Viewer** (can only look; code today: reader), **invite link**, **album**.

## Today, in one paragraph

An invite link carries a one-time invite code, the Admin's id and the album name (`apps/web/src/utils/invite-link.ts`); the name and Admin are unsigned hints. The joiner sees "Ask to join", sends a request and waits until the Admin accepts or declines (`apps/web/src/machines/sharing/join-request-machine.ts`). Approval decides who may add photos (`docs/design/ui-ux-spec.md` §2.3, lines 108-113). Old links that carry the album key no longer parse.

## What changes

- The link carries a one-time invite code instead of the key, and it expires.
- Every joiner waits for the Admin to accept them, as a Viewer or as a Collaborator.
- The Admin can change a role later.
- The Remove button shows only where it will work, and its text says what really happens.

## Story 1: two friends

Nils (Admin) made "Spain 2026" and wants Maya to see and add photos.

**Nils's side**

1. Opens the album, taps **Invite**, picks how long the link lasts (10 minutes, 1 hour, **1 day**, 7 days).
2. Sees the link and QR with "Valid until tomorrow, 14:05" and a **Cancel link** button. Sends it to Maya.
3. Later a request appears in People: "Maya wants to join". Taps **Accept as Collaborator** (or **Accept as Viewer**).
4. Maya now shows in People with her role. He can change it any time.

**Maya's side**

1. Opens the link. Sees "Join Spain 2026? Started by Nils. 1 person." and the existing consent text: "You'll see every photo in this album, old and new, and a copy is kept on this phone. People in the album can see when you have Justus open."
2. Taps **Ask to join**. Sees "Waiting for Nils".
3. After 30 seconds: "Nils's phone needs Justus open to let you in."
4. Accepted: "You're in. You can add photos." (Collaborator) or "You're in. You can look, but not add photos." (Viewer).

**Failure paths**

- _Nils's phone is closed._ Maya stays on "Waiting for Nils" with the hint above. The request is delivered when his phone is next open. Nothing is lost, but nothing moves either. Cost of the new design: Viewers also need the Admin's phone open (today only adding photos does).
- _Link expired._ Maya sees "This link has expired. Ask Nils for a new one." No request reaches Nils.
- _Link cancelled._ Same screen and same text as expired.
- _Declined._ Maya sees "Nils did not accept your request." Nothing is shared.
- _Request from an unknown name._ The name is what the requester typed; Nils cannot verify it. The request shows the name, which link it came through and when it arrived (for example "via the 1 day link made on Tuesday"), and only Nils can accept it. Verifying who a requester is stays out of scope.
- _Maya cancels_ while reviewing or waiting: nothing is sent, or the request is withdrawn.

## Story 2: a big group where everyone adds photos

Nils runs "Wedding" for 40 guests who should all add photos.

**Nils's side**

1. Makes a **7 day** link and posts it to the group chat.
2. As requests arrive the People list grows. He taps **Accept all as Collaborators** or accepts person by person.
3. When the week is over the link expires on its own. Anyone already queued stays acceptable; new requests are refused.
4. If a stranger got in the chat, he taps **Cancel link** and no further requests arrive.

**A guest's side**
Same as Story 1. Guests who open the link after expiry see "This link has expired".

**Notes**

- One Admin approving 40 people is slow. Recommendation: add "Accept all" to the request list. Letting Collaborators approve or invite needs a shared Admin role; that is a separate design (open question 5).
- A Collaborator can add photos and remove their own. They cannot remove other people's.

## Story 3: a big group joining your personal album

Nils has "Nils's photos" with years of pictures. His family wants to look, not add.

**Nils's side**

1. Makes a **1 hour** link (short, because the album is personal) and sends it to the family chat.
2. Accepts each request as **Viewer** (the default), or uses **Accept all as Viewers**.
3. Later promotes his sister to Collaborator from People.

**A relative's side**
Same as Story 1, ending in "You're in. You can look, but not add photos."

**Failure paths**

- Relative opens the link after an hour: "This link has expired".
- Link forwarded to someone Nils does not know: the request shows an unfamiliar name and Nils declines.
- Someone Nils removed earlier asks again with a new link: allowed, and Nils decides again (open question 6).

## Roles

| Action                          | Viewer | Collaborator | Admin |
| ------------------------------- | ------ | ------------ | ----- |
| View photos                     | yes    | yes          | yes   |
| Add photos                      | no     | yes          | yes   |
| Remove own photos               | yes\*  | yes          | yes   |
| Remove anyone's photo           | no     | no           | yes   |
| Make or cancel invite link      | no     | no           | yes   |
| Accept or decline requests      | no     | no           | yes   |
| Change a role / remove a person | no     | no           | yes   |

\*A Viewer has no photos of their own unless they were a Collaborator before.

There is one Admin per album and the role cannot be handed over yet.

## Removing photos

Rules (this is what the backend already does):

- **Own photo:** the owner's drive entry is deleted (`apps/backend/src/photo-store.ts:2026-2036`).
- **Admin removing someone else's photo:** a tombstone `driveKey:id` is written to `removed.json` on the album drive and the photo is hidden from the album (`photo-store.ts:2037-2058`, `gallery-order.ts:73-80`). The photo stays on the other person's phone.
- **Anyone else:** `NOT_FOUND` (`photo-store.ts:2060`).
- If a Collaborator becomes a Viewer, their photos stay. They can still remove their own.

What "remove" really means: removing hides the photo for everyone as their devices sync. Nobody can wipe a copy another phone already received, and a drive delete keeps history blocks. Removing a person does not take back the key they already hold.

Proposed copy:

- Own photo: "Removes it from the album for everyone. Phones that already have it may keep a copy."
- Admin removing another's photo: "Hides it from the album for everyone. It stays on Maya's phone."

Today the app does not match these rules:

- The Remove button shows on every tile and in the lightbox, whatever the role (`apps/web/src/views/gallery.ts:316-324`, `apps/web/src/views/lightbox.ts:161-168`), so Viewers and Collaborators get a failed remove on other people's photos.
- The confirm text says "It will disappear from everyone's phone in this album." (`gallery.ts:282`, `lightbox.ts:58`), which claims too much.
- `CONTEXT.md` said the Admin "Cannot touch others' photos", which contradicts `photo-store.ts:2026-2058`. This PR corrects that row.
- `Photo.mine` already exists (`packages/core/src/photos/types.ts:37`), so "can remove" is `photo.mine || role === "creator"`.

## Expiry options

| Choice              | Use                                |
| ------------------- | ---------------------------------- |
| 10 minutes          | in person, QR                      |
| 1 hour              | a chat you are watching            |
| **1 day** (default) | most invites                       |
| 7 days              | a big group that joins over a week |

There is no "never". A request is judged when it reaches the Admin's device. Requests already queued stay acceptable after expiry. **Cancel link** ends a link at once. Every join still needs an Accept, so expiry mostly stops old links from collecting strangers' requests.

Expiry works with no server because only the Admin's phone hands out the key, so only it checks the clock. It cannot stop someone who already has the key from passing it on.

## Open questions (recommendation in bold)

1. **Expiry choices?** **10 minutes, 1 hour, 1 day, 7 days; default 1 day; no "never".**
2. **Word for people who can add photos?** **Collaborator** (Viewer is the default when accepting), rather than today's "Member".
3. **Who can remove a photo?** **Whoever added it, and the Admin (removes it for everyone). Collaborators cannot remove other people's photos. Viewers cannot remove anything. No per-person setting.**
4. **Switching a Collaborator to Viewer: do their photos stay?** **Yes.** They cannot add more and can still remove their own.
5. **Big groups: one Admin approving 40 people is slow.** **Add "Accept all as Collaborators" and "Accept all as Viewers" to the request list for now.** Collaborators approving or inviting is a separate design.
6. **Can someone you removed ask again with a new link?** **Yes; the Admin decides again.**

## Not included

Auto-accept, Collaborators approving or inviting, handing over the Admin role, undo or a "recently removed" bin, verifying who a requester really is, taking back the key from someone already removed, and making links expire on the network (a follow-up).

## Walks

Each link opens the machine at the end of the walk; click on from there or press Back. Every walk is a test of the same name, so the link and the machine stay in step. Each story has one link per side: the joiner (`joinRequest`), the invite link on the Admin's phone (`inviteLink`) and the Admin's decision about the person (`membership`). The page has no member list, so every save works there. In the Admin walks the requester's name is a sample ("Ann"), not the name used in the story.

### Story 1: two friends

- [Maya: asks and is accepted](https://anderscan.github.io/justus/join-an-album/?machine=joinRequest&run=Maya%3A%20asks%20and%20is%20accepted)
- [Maya: asks and is declined](https://anderscan.github.io/justus/join-an-album/?machine=joinRequest&run=Maya%3A%20asks%20and%20is%20declined)
- [Maya: reopens her ask while waiting](https://anderscan.github.io/justus/join-an-album/?machine=joinRequest&run=Maya%3A%20reopens%20her%20ask%20while%20waiting)
- [Maya: reopens her ask after a decline](https://anderscan.github.io/justus/join-an-album/?machine=joinRequest&run=Maya%3A%20reopens%20her%20ask%20after%20a%20decline)
- [Maya: opens a link from before the new key](https://anderscan.github.io/justus/join-an-album/?machine=joinRequest&run=Maya%3A%20opens%20a%20link%20from%20before%20the%20new%20key)
- [Nils picks 1 hour, sends the link, and the panel offers the picker again once it ends](https://anderscan.github.io/justus/invite-someone/?machine=inviteLink&run=Nils%20picks%201%20hour%2C%20sends%20the%20link%2C%20and%20the%20panel%20offers%20the%20picker%20again%20once%20it%20ends)
- [Nils turns off the links, it fails, and his link stays shown](https://anderscan.github.io/justus/invite-someone/?machine=inviteLink&run=Nils%20turns%20off%20the%20links%2C%20it%20fails%2C%20and%20his%20link%20stays%20shown)
- [Nils: accepts Maya as Collaborator](https://anderscan.github.io/justus/join-an-album/?machine=membership&run=Nils%3A%20accepts%20Maya%20as%20Collaborator)
- [Nils: declines the request](https://anderscan.github.io/justus/join-an-album/?machine=membership&run=Nils%3A%20declines%20the%20request)

### Story 2: a big group where everyone adds photos

A guest's side is the Story 1 Maya walks.

- [Nils: accepts a guest as Collaborator](https://anderscan.github.io/justus/join-an-album/?machine=membership&run=Nils%3A%20accepts%20a%20guest%20as%20Collaborator)

### Story 3: a big group joining your personal album

- [Nils: accepts a relative as Viewer, later makes her a Collaborator](https://anderscan.github.io/justus/join-an-album/?machine=membership&run=Nils%3A%20accepts%20a%20relative%20as%20Viewer%2C%20later%20makes%20her%20a%20Collaborator)

### Story 4: archive, leave or delete an album

- [Maya archives Summer and brings it back](https://anderscan.github.io/justus/archive-or-delete/?machine=albumLifecycle&run=Maya%20archives%20Summer%20and%20brings%20it%20back)
- [Maya leaves Hytta, and is gone once Nils's phone sees it](https://anderscan.github.io/justus/archive-or-delete/?machine=albumLifecycle&run=Maya%20leaves%20Hytta%2C%20and%20is%20gone%20once%20Nils's%20phone%20sees%20it)
- [A Viewer leaves Hytta](https://anderscan.github.io/justus/archive-or-delete/?machine=albumLifecycle&run=A%20Viewer%20leaves%20Hytta)
- [Nils deletes Hytta for everyone](https://anderscan.github.io/justus/archive-or-delete/?machine=albumLifecycle&run=Nils%20deletes%20Hytta%20for%20everyone)
- [Maya's phone hears that Nils deleted Hytta, after being away](https://anderscan.github.io/justus/archive-or-delete/?machine=albumLifecycle&run=Maya's%20phone%20hears%20that%20Nils%20deleted%20Hytta%2C%20after%20being%20away)
- [Maya had archived Hytta when Nils deleted it](https://anderscan.github.io/justus/archive-or-delete/?machine=albumLifecycle&run=Maya%20had%20archived%20Hytta%20when%20Nils%20deleted%20it)
- [Maya leaves Hytta, and Nils deletes it before his phone sees her leave](https://anderscan.github.io/justus/archive-or-delete/?machine=albumLifecycle&run=Maya%20leaves%20Hytta%2C%20and%20Nils%20deletes%20it%20before%20his%20phone%20sees%20her%20leave)
