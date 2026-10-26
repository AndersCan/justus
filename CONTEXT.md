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
A device enrolled in a folder with its own drive it can add photos to. Enrollment is creator-mediated: the creator records the member's drive key in the registry. A Person above Member is proposed in `docs/design/person-identity-spec.md`.
_Avoid_: device, user, peer, writer

**Reader**:
A device that joined a folder read-only by share key — it can view and seed but has no own drive and cannot add photos.
_Avoid_: guest, viewer

**Creator**:
The member whose device created the folder and owns its registry; the only one who can enroll or remove members.
_Avoid_: owner, host

**Registry**:
The creator-owned membership record mapping members to their drive keys.
_Avoid_: member list, contacts

**Share key**:
The secret that grants access to a folder — the creator drive's key. Anyone holding it can read the folder; writer enrollment additionally records a member's own drive key.
_Avoid_: invite code, link, password

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
The UI bundle (lit-html + nanostores) that runs in the browser or WebView and talks to the backend over a WebSocket.
_Avoid_: frontend, client, app

**Host**:
The native shell (Android/iOS) that starts the backend, owns system APIs (camera, picker), and injects the session token.
_Avoid_: launcher, wrapper

**Actor**:
A mantaq state machine that owns a slice of app state. All state in Justus is modeled with actors; each actor's change handler writes module-scope nanostore atoms, and the UI reads them reactively via computed view-models.
_Avoid_: reducer, store, controller

**Encryption**:
Photos are encrypted at rest and in transit by the storage layer, and access is keyed by the share key. Not zero-knowledge: any member holding the share key can read any photo.
_Avoid_: e2e encrypted (misleading), end-to-end encrypted

## User-facing words

The code terms above are precise; the UI uses plainer ones. Never show the left column to users.

| Code / docs term | User sees                      | Notes                                                                                    |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| Folder           | **Album**                      | Create, share, join an album. There is no separate local "albums" feature.               |
| Creator          | **Admin** ("started by Maya")  | Manages who is in. One per album, not transferable yet. Cannot touch others' photos.     |
| Member           | **Member**                     | Can add photos.                                                                          |
| Reader           | **Viewer**                     | Can only look.                                                                           |
| Share key        | **Invite**                     | Delivered as copyable link, QR, or pasted key. Joining still needs Admin approval.       |
| Registry         | _(hidden)_                     |                                                                                          |
| Profile          | **Profile**                    | Display name (required) + auto colour/initials. Local; shared only with albums you join. |
| Peer connection  | **Connected** (never "online") | Only who your device can reach right now. Others show "last seen".                       |

**Profile**:
The user's display name and auto-assigned colour, set on first run. No account, email or password. Device labels are derived automatically.

**Connected**:
A member whose device this device has a live connection to. P2P cannot know more than this; mobile carrier NAT means a friend may be using the app yet unreachable.
_Avoid_: online, active
