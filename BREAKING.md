# Breaking changes

Newest first. A change that breaks saved data, links, the peer protocol or the
app's backend API adds an entry here in the same PR, and raises the version it
breaks (`apps/backend/src/versions.ts`). Any change to a file on a drive raises
`PEER_PROTOCOL`.

## Unreleased · peer protocol 4

- **An album from before 2026-10-28 is cleared off the phone's identity drive** after it moved. Who: testers whose first album predates #195. Do: nothing.
- **Join asks are sealed to the Admin's phone** (`/requests.json` invite entries carry `sealedKey`, not `requesterKey`; the identity drive's `/device.json` gains `boxKey`). Who: internal testers on a protocol-4 build from before this change. Their asks are not listed by an updated Admin, and an Admin on such a build does not see asks from updated phones. Collaborators who joined before keep their old drive key in their outbox history: photos they added before stay readable to anyone who knows their friend key until a Remove moves the album. Do: update Justus.
- **Who has each photo** (`/holding.json`, `/held/<id>` on each phone's album drive). Who:
  testers on v0.2.5 or older, already refused by protocol 4. Do: update Justus.
- **People who left or were removed** (`/former.json` on the album drive, written by the Admin; entries may carry `"left": true`).
  Who: testers on v0.2.5 or older, already refused by protocol 4. Do: update Justus.
- **A removed person's phone tells the Admin's phone it deleted its copy** (new peer messages `copyDeleted`, `copyDeletedSeen`; `/former.json` entries from a Remove carry `"album"`).
  Who: testers on v0.2.5 or older, already refused by protocol 4. Do: update Justus.
- **The Admin's phone turns away asks sent after its invite links ended.** Who: testers who
  sent a link before updating. An invite link sent before this update stops getting asks
  through once the Admin has made a link after updating and that newer link has ended. Do: send
  a new link.
- **Removing someone moves the album to new keys** (new drive file `/earlier.json`, new
  `move` field on invite offers). Who: testers on v0.2.5 or older. Their phones show
  "<name> needs to update Justus" and stop syncing with updated phones. Do: update Justus.

## Unreleased · next release after v0.2.1 · peer protocol 3, saved state 2

- **Signed device records** (`/device.json` gains `identityPublicKey` and `identitySig`).
  Who: testers on internal builds from before this change. Their phones show in albums
  without a Friend label and cannot be saved as a friend. Do: update Justus.
- **Viewers** (`/viewers.json` on the album's drive). Who: albums with phones on
  different versions. An older Justus would not list Viewers or count them. Do:
  everyone updates; the newer phone shows "<name> needs to update Justus". A
  Collaborator made a Viewer keeps their photos (`keptVersion`); a build without it
  shows them as a Viewer with no photos.
- **Delete and leave.** Albums can be deleted for everyone and members can leave; phones on
  an older Justus no longer sync with this one. Who: mixed-version groups. Do: everyone
  updates.
- **Android app data moves** out of the cache folder into app storage on first start.
  Who: anyone who installs an older Justus over this one (only possible with
  `adb install -d`); it starts with no albums. Do: update again; the albums come back.
- **Invite links carry an end time** (`e=`). Who: testers on internal builds. An app
  from before this change ignores it, and links made before it never expire.
- **Album keys.** Every album you started moves to a new key on first start; its
  photos stay. Members are dropped. Who: every album owner and member. Do: owners
  send a new invite link; members ask for one.
- **Old invite links** (`justus://join/<key>`) no longer work. Who: anyone holding
  one. Do: ask the album owner for a new link.
- **Saved state** (`justus.json`) is version 2; an older Justus refuses to open it
  ("Update Justus to open your albums."). Who: anyone who downgrades. Do: update.
- **Peer protocol 2.** Phones on an older Justus no longer sync with this one; the
  newer phone shows "<name> needs to update Justus". Who: mixed-version groups.
  Do: everyone updates.
