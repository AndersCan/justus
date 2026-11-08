# Justus

Justus is a photo-sharing app that lives on many platforms at once (web, Android, iOS, desktop) — for sharing photos with friends and family, peer-to-peer, with no server and no account. It is not a device-sync or backup tool: it only ever holds photos the user deliberately adds. It is built as a consumer of `@ekrooh/bare` to validate the framework.

## Language

**Photo**:
A single image captured or picked on a device and stored in the folder. Photos enter the app only through the system picker or camera; Justus never scans a library.
_Avoid_: media, file, asset

**Folder**:
The peer-to-peer share unit: the creator's drive (holding the membership registry) plus each member's own single-writer drive. A folder is identified by its share key. Users see this as an **Album** (see _User-facing words_); `Folder` remains the code and storage term.
_Avoid_: drive, collection

**Member**:
A device enrolled in a folder with its own drive it can add photos to. That drive belongs to this one folder: a device has a separate drive in every folder it joins, never shared with another folder or with its identity. Enrollment is creator-mediated: the creator records the member's drive key in the registry. A Person above Member is proposed in `docs/design/person-identity-spec.md`.
_Avoid_: device, user, peer, writer

**Reader**:
A device that joined a folder read-only by share key — it can view and seed but has its own drive, read by others only to see when it is connected; it cannot add photos. It is a pending joiner, a Viewer the Admin listed in `/viewers.json`, or a removed member.
_Avoid_: guest, viewer

**Creator**:
The member whose device created the folder and owns its registry; the only one who can enroll or remove members.
_Avoid_: owner, host

**Registry**:
The creator-owned membership record mapping members to their drive keys.
_Avoid_: member list, contacts

**Share key**:
The secret that grants access to a folder — the creator drive's key. Anyone holding it can read the folder; writer enrollment additionally records a member's own drive key.
_Avoid_: link, password

**Invite code**:
A random per-album code in the invite link, in place of the share key. It names a swarm topic only the Admin's device serves, so a link holder meets nobody else and learns nothing of the album. It grants no access.
_Avoid_: share key, link

**Ask**:
A device's request to join an album through an invite code. It waits until the Admin answers: accepted, the share key travels to the asker over a verified connection and the asker joins; declined, that ask is closed; the device may ask again and the Admin answers the new ask. Both devices must be online at once to deliver the answer.
_Avoid_: join request (the older request made with a share key)

**Check code**:
Eight digits worked out from a phone's identity drive key. The asker's waiting screen and the Admin's request row show the same code, so the Admin can ask which code a person sees before accepting. It proves nothing alone.
_Avoid_: PIN, password, safety number

**Delete note**:
`/deleted.json` in the album's own drive. Only the Admin's device can write it. A phone that reads it removes the album and its photos.
_Avoid_: tombstone

**Archive**:
Hides an album on this phone only. It leaves Your albums and the timeline, and keeps syncing.
_Avoid_: hide, mute

**Gallery**:
The app's view over a folder's photos, ordered and rendered for browsing.
_Avoid_: photo list, feed

**Sync**:
The background replication of photos and the folder index between members' devices over the peer-to-peer network.
_Avoid_: backup, upload, share

**Backend**:
The worklet process that runs on each device: owns the folder's storage and sync machinery, and serves the web layer over the loopback server.
_Avoid_: server, cloud

**Web layer**:
The UI bundle (lit-html + mantaq) that runs in the browser or WebView and talks to the backend over a WebSocket.
_Avoid_: frontend, client, app

**Host**:
The native shell (Android/iOS) that starts the backend, owns system APIs (camera, picker), and injects the session token.
_Avoid_: launcher, wrapper

**Peer key**:
The noise public key of a device's swarm connection. It is random and changes every boot, and it is never a drive key. Presence uses it to tell which member a connection belongs to; the member publishes it in `/device.json`.
_Avoid_: device key, identity key, node id

**Identity drive**:
The device's own keyless drive. It holds `/device.json` and the join-request outbox, and no photos. Peers learn its key over the identity greeting on each connection, so an Admin can read the requests a device filed. Each album drive's `/device.json` names the identity drive and carries a signature by it for that drive, and a member's identity is trusted only when that signature checks out.
_Avoid_: own drive, profile drive

**Actor**:
A mantaq state machine that owns a slice of app state. All state in Justus is modeled with actors; views read actor state reactively through `@mantaq/lit`.
_Avoid_: reducer, store, controller

**Encryption**:
Photos are encrypted in transit (Hyperswarm's Noise connections). At rest they are not encrypted by Justus: the corestore, which holds the seed every drive key is derived from, lives in the app's storage dir (Android `filesDir/bare`, iOS `Documents/bare`) and the photo spool in its cache dir; both are plain files, protected only by the OS (Android and iOS encrypt app storage; desktops only with FileVault/LUKS). The storage dir is kept out of OS backups and device transfer, so keys never leave the phone and a new phone starts fresh. Access is keyed by the share key: anyone holding it can read every photo, approved or not, and removing someone moves the album to new keys, so they get nothing added after it.
_Avoid_: e2e encrypted (misleading), end-to-end encrypted

## User-facing words

The code terms above are precise; the UI uses plainer ones. Never show the left column to users.

| Code / docs term | User sees                      | Notes                                                                                      |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| Folder           | **Album**                      | Create, share, join an album. There is no separate local "albums" feature.                 |
| Creator          | **Admin** ("started by Maya")  | Manages who is in. One per album, not transferable yet. Can delete others' photos for all. |
| Member           | **Collaborator**               | Can add photos. The Admin picks Viewer or Collaborator on Accept.                          |
| Remove (photo)   | **Delete**                     | The adder or the Admin. Gone for everyone; no undo.                                        |
| Reader           | **Viewer**                     | Sees every photo, adds none.                                                               |
| Archive (album)  | **Archive**                    | This phone only; Restore from Archived.                                                    |
| Leave (album)    | **Leave album**                | Member or Viewer; needs a new invite to come back.                                         |
| Delete (album)   | **Delete album**               | Admin only; gone from every phone; no undo.                                                |
| Check code       | **Check code**                 | Shown on the request and the waiting screen.                                               |
| Share key        | **Invite**                     | Copyable link or QR. Opens nothing; the person asks and the Admin accepts.                 |
| Registry         | _(hidden)_                     |                                                                                            |
| Profile          | **Profile**                    | Display name (required) + auto colour/initials. Local; shared only with albums you join.   |
| Peer connection  | **Connected** (never "online") | Only who your device can reach right now. Others show "last seen".                         |

**Profile**:
The user's display name and auto-assigned colour, set on first run. No account, email or password. Device labels are derived automatically.

**Connected**:
A member whose device this device has a live connection to. P2P cannot know more than this; mobile carrier NAT means a friend may be using the app yet unreachable.
_Avoid_: online, active
