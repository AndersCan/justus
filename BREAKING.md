# Breaking changes

Newest first. A change that breaks saved data, links, the peer protocol or the
app's backend API adds an entry here in the same PR, and raises the version it
breaks (`apps/backend/src/versions.ts`). Any change to a file on a drive raises
`PEER_PROTOCOL`.

## Unreleased · next release after v0.2.1 · peer protocol 2, saved state 2

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
