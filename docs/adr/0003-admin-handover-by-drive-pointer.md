# 3. An Admin hands an album on with a drive pointer and signed link proofs

Status: accepted (2026-11-18). Context: #824.

## Context

The Admin's drive holds the six list files (`/members.json`, `/viewers.json`,
`/folder.json`, `/removed.json`, `/earlier.json`, `/former.json`) every phone
reads. When the Admin leaves, the album must go on under a Collaborator, also
on phones that are off, and people who asked with the old links must reach the
new Admin.

## Decision

1. **A pointer on the old drive.** The leaving Admin writes `/admin.json`
   (`version`, `next.key`, `next.identity`, `next.name`, `at`) as that drive's
   last write. The next Admin's own drive first takes the six lists
   (`takeAdminRecords`), `/members.json` last, so a readable member list means
   a whole copy.
2. **Every phone follows the pointer** (`followAdmin`), so a phone that was off
   catches up from the drives alone. A hop is taken only when the next key is a
   Collaborator in the current lists, its `/device.json` verifies to the named
   identity, its `/members.json` reads, and it is not a cycle. The chain stops
   at 16; a failed hop is retried on the next change.
3. **Links keep working through signed proofs.** For each invite code the
   leaving Admin signs `justus-handover/v1:<code>:<next identity>` with their
   identity. An asker given the proof chain (`handedOver` answer) checks
   `chainReaches` from the Admin they asked to the Admin who answers. A chain
   of such links covers later handovers.
4. **Peer messages** (`handover`, `handoverReady`, `handoverDone`,
   `handoverCancelled`) carry the package of links, retired codes and answers.
   `handoverReady` carries `listsDigest` of the lists as the next Admin copied
   them; the leaving Admin finishes only when it matches the digest of what it
   sent.
5. **Version 1 only.** Another version is not followed.

## Consequences

No server and no key moves: trust comes from the old lists and the new drive's
identity proof. Whether the leaving Admin's photos stay is left open.
