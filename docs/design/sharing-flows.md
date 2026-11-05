# Sharing flows: links that expire, accept as Viewer or Collaborator, who can remove photos

Status: proposal for review. Nothing here changes app behaviour yet. Tracked in #78 (sharing) and #79 (removing photos). Machines and walks come in later PRs; the "Walks" section is a placeholder until then.

Words used: **Admin** (code: creator), **Collaborator** (can add photos; code today: member), **Viewer** (can only look; code today: reader), **invite link**, **album**.

## Today, in one paragraph

An invite link is the album's key. The link is `justus://join/<64-hex share key>?n=&a=&m=` (`apps/web/src/utils/invite.ts:13-24`); the name, Admin and member count are unsigned hints (`invite.ts:1-11`). Anyone who gets the link sees every photo, forever: "Anyone holding it can read every photo, approved or not, and removal does not revoke it" (`CONTEXT.md`, Encryption). The joiner confirms and joins straight away, with no waiting step (`apps/web/src/machines/invite-machine.ts:64-73`). Approval only decides who may add photos (`docs/design/ui-ux-spec.md` §2.3, lines 108-113).

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
3. Later a request appears in People: "Maya wants to join". Taps **Accept as Collaborator** (or **Accept as Viewer**, the default).
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
- _Request from an unknown name._ The name is what the requester typed; Nils cannot verify it. The request shows the name plus when it arrived, and only Nils can accept it. Verifying who a requester is stays out of scope.
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

- **Own photo:** the owner's drive entry is deleted (`apps/backend/src/photo-store.ts:2023-2033`).
- **Admin removing someone else's photo:** a tombstone `driveKey:id` is written to `removed.json` on the album drive and the photo is hidden from the album (`photo-store.ts:2034-2054`, `gallery-order.ts:73-80`). The photo stays on the other person's phone.
- **Anyone else:** `NOT_FOUND` (`photo-store.ts:2060`).
- If a Collaborator becomes a Viewer, their photos stay. They can still remove their own.

What "remove" really means: removing hides the photo for everyone as their devices sync. Nobody can wipe a copy another phone already received, and a drive delete keeps history blocks. Removing a person does not take back the key they already hold.

Proposed copy:

- Own photo: "Removes it from the album for everyone. Phones that already have it may keep a copy."
- Admin removing another's photo: "Hides it from the album for everyone. It stays on Maya's phone."

Today the app does not match these rules:

- The Remove button shows on every tile and in the lightbox, whatever the role (`apps/web/src/views/gallery.ts:316-324`, `apps/web/src/views/lightbox.ts:161-168`), so Viewers and Collaborators get a failed remove on other people's photos.
- The confirm text says "It will disappear from everyone's phone in this album." (`gallery.ts:281`, `lightbox.ts:58`), which claims too much.
- `CONTEXT.md` said the Admin "Cannot touch others' photos", which contradicts `photo-store.ts:2033-2054`. This PR corrects that row.
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
5. **Big groups: one Admin approving 40 people is slow.** **Add "Accept all as viewers" to the request list for now.** Collaborators approving or inviting is a separate design.
6. **Can someone you removed ask again with a new link?** **Yes; the Admin decides again.**

## Not included

Auto-accept, Collaborators approving or inviting, handing over the Admin role, undo or a "recently removed" bin, verifying who a requester really is, taking back the key from someone already removed, and making links expire on the network (a follow-up).

## Walks

_To be filled in once the sharing machines land: one link per side (joiner, link, Admin) for each story above._
