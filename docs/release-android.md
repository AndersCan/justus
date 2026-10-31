# Releasing Android to Google Play

How a Justus Android build gets from `main` to the Play Store. The work is split
three ways:

- **GitHub Actions** (`.github/workflows/release-android.yml`) runs fastlane on
  a `v*` tag.
- **[fastlane](https://docs.fastlane.tools)** (`apps/android/fastlane/Fastfile`)
  builds and signs the bundle, uploads it to Play's internal track, and later
  promotes it and stages the rollout.
- **Play Console** holds the store listing and the policy forms, and does the
  final review.

Package name (applicationId): `no.cankode.justus`, fixed forever by Play. The
Kotlin `namespace` stays `io.justus.app`. Signing uses **Play App Signing**: Google keeps the
app signing key, and we hold only the **upload key**.

---

## Part A: one-time setup

Do this once. Tick items off in a GitHub issue, not in this file.

### A1. Google Play developer account

1. Register at <https://play.google.com/console/signup>. There's a one-time US$25
   fee and identity verification, which can take days.
2. **Personal accounts** created after Nov 2023 must run a **closed test with at
   least 12 testers for 14 continuous days** before Play unlocks production.
   Plan for this: it's usually the longest step. Organization accounts (which
   need a D-U-N-S number) skip it.

### A2. Things the app still lacks

Play rejects or blocks the release without these:

- [ ] **Store assets:** a 512×512 icon, a 1024×500 feature graphic, and at least
      2 phone screenshots. Screenshots from the arm64 emulator are fine.
- [ ] **Privacy policy URL**, hosted publicly (GitHub Pages works). It must match
      what we actually do: no server, data stays on devices and with chosen peers.
- [ ] **Target SDK.** Play requires the current target API level, which is
      **36** (Android 16) since 31 Aug 2026. It rises every August; check
      <https://developer.android.com/google/play/requirements/target-sdk>.
      AGP 8.5.2 warns on `compileSdk = 36` but builds. Bump AGP when convenient.

### A3. Create the upload key (do it once and back it up)

```bash
mkdir -p ~/justus-secrets
keytool -genkeypair -v -keystore ~/justus-secrets/justus-upload.jks \
  -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

- Store the `.jks` file and both passwords in a password manager. Losing the
  upload key isn't fatal (Play support can reset it), but it costs days.
- **Never commit it.** `*.jks` and `apps/android/keystore.properties` are
  gitignored.
- For local release builds, copy `apps/android/keystore.properties.example` to
  `apps/android/keystore.properties` and fill it in. `storeFile` is relative to
  `apps/android/`.

### A4. GitHub secrets

Create a GitHub **Environment** named `play` (Settings → Environments), then add
these secrets to it:

| Secret                          | Value                                                    |
| ------------------------------- | -------------------------------------------------------- |
| `JUSTUS_UPLOAD_KEYSTORE_BASE64` | `base64 -i ~/justus-secrets/justus-upload.jks \| pbcopy` |
| `JUSTUS_UPLOAD_STORE_PASSWORD`  | keystore password                                        |
| `JUSTUS_UPLOAD_KEY_ALIAS`       | `upload`                                                 |
| `JUSTUS_UPLOAD_KEY_PASSWORD`    | key password                                             |
| `PLAY_SERVICE_ACCOUNT_JSON`     | contents of the service-account JSON key (A7)            |

Also add an environment **variable** `PLAY_RELEASE_STATUS` = `draft` until the
app has been reviewed and published once (see A7). Delete it afterwards.

Optionally add yourself as a required reviewer on the `play` environment, so
every release build waits for a click.

### A5. Create the app in Play Console

1. Play Console → **Create app**. Name: Justus. Package name: `no.cankode.justus`
   (must equal `applicationId`). Type: App, Free. Accept the
   declarations.
2. Fill in **Dashboard → Set up your app**. Every item is required:
   - **Privacy policy** URL (from A2).
   - **App access:** all functionality is available without login.
   - **Ads:** No.
   - **Content rating** questionnaire. Category: Social / communication. Users
     can share photos with each other, so answer the user-generated-content
     questions honestly.
   - **Target audience:** 18+ (avoids the Families policy).
   - **Data safety:** no data is collected or shared with us. Photos travel
     peer-to-peer, encrypted in transit (Hyperswarm / Noise). Users can delete
     their data in the app. Re-read `vision.md` and make sure the form matches
     the code.
   - **Government / financial / health apps:** No.
3. **Store listing:** the text lives in the repo, in
   `apps/android/fastlane/metadata/android/en-US/` (`title.txt` max 30 chars,
   `short_description.txt` max 80, `full_description.txt` max 4000). Edit it
   there and push it with `fastlane listing` (needs A6 and A7). Until then,
   paste the same text into Play Console by hand. The 512×512 icon
   (`images/icon.png`) and 1024×500 feature graphic (`images/featureGraphic.png`)
   are rendered from their `.svg` sources by
   `node apps/android/scripts/render-store-art.mjs`. Phone screenshots are
   `images/phoneScreenshots/1.jpg`, `2.jpg`, … (shown in name order).

### A6. First upload (manual, required once)

The Play Developer API, and so fastlane, can only change an app that already has
a build. The first bundle must go through the Play Console UI.

1. Run the workflow: GitHub → Actions → **release-android** → _Run workflow_,
   `version_name` = `0.1.0`, **untick `upload`**. This builds with versionCode 1
   and skips Play.
2. Download the `justus-android-aab` artifact and unzip it to get
   `app-release.aab`.
3. Play Console → **Testing → Internal testing → Create new release**.
   - Accept **Play App Signing** when asked (Google generates the app signing
     key; our `.jks` becomes the upload key).
   - Upload `app-release.aab`, add release notes, and roll out to internal
     testing.
4. Add your Google account as an internal tester, install from the opt-in link,
   and check that the app boots on a real arm64 phone.

### A7. Give fastlane access to Play

1. **Google Cloud:** create (or pick) a project and enable the **Google Play
   Android Developer API**. Create a service account (skip the role steps),
   then _Manage keys → Add key → JSON_. Save it as
   `~/justus-secrets/play-service-account.json` and in the password manager,
   then paste its contents into the `PLAY_SERVICE_ACCOUNT_JSON` secret (A4).
2. **Play Console → Users and permissions → Invite user**: the service-account
   email, no access expiry. Under App permissions → Add app → Justus, grant:
   - View app information (read-only)
   - Release to production, exclude devices, and use Play App Signing
   - Release apps to testing tracks
   - Manage testing tracks and edit tester lists
   - Manage store presence (for `fastlane listing`)
3. Check the key from your Mac (`brew install fastlane` once; the system Ruby
   is too old for the Gemfile):
   ```bash
   cd apps/android
   fastlane run validate_play_store_json_key json_key:~/justus-secrets/play-service-account.json
   ```
4. **Draft-only until published.** Until the app's first review is through,
   Play's API rejects anything but `draft` releases. Keep the `PLAY_RELEASE_STATUS=draft`
   variable from A4 set until then, and roll out each draft by hand in Play
   Console.

### A8. Closed test (personal accounts only)

1. Play Console → **Testing → Closed testing**: create a track and add at least
   12 testers (a Google Group or an email list).
2. Promote a build to it: `fastlane promote from:internal to:alpha` (`alpha` is
   Play's closed track), or use the Console. Testers must opt in
   and stay opted in for 14 days.
3. Then **Dashboard → Apply for production access**.

---

## Part B: every release

1. **Gate locally.** `vp check`, `vp run -r test`, and `pnpm test:native`
   (Maestro on the arm64 AVD). The release workflow repeats all three (Maestro
   on an x86_64 emulator) before uploading, but on the debug APK: release
   builds differ (no WebView debugging, 15 s handoff deadline instead of 90 s),
   so step 3 still matters.
2. **Build and upload:** push tag `vX.Y.Z`, or run the workflow with
   `version_name`. CI runs `fastlane internal`, which:
   - sets `versionCode` to one above the highest code on any Play track, so a
     code is never reused, even after a manual upload;
   - takes `versionName` from the tag or input;
   - builds the signed bundle, refuses an unsigned one, and uploads it to the
     **internal** track.
3. **Smoke-test** the internal build on a real arm64 phone (install from the
   Play internal-testing link).
4. **Promote to production with a staged rollout**, from `apps/android`:
   ```bash
   fastlane promote from:internal to:production rollout:0.1   # 10%
   fastlane rollout rollout:0.5                               # 50%
   fastlane rollout rollout:1                                 # 100%
   ```
   To halt a bad rollout, use Play Console → Production → _Halt rollout_.
5. **Release notes:** write them in Play Console (500 chars per language).

### When an ekrooh release lands

Bump `@ekrooh/bare` and the `bare-host` AAR together (see `AGENTS.md`), run the
full gate, and only then cut a store release.

---

## Troubleshooting

| Symptom                                                               | Cause / fix                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| fastlane: _"app-release.aab is unsigned"_                             | `JUSTUS_UPLOAD_*` secrets are missing, or the job isn't using the `play` environment.     |
| Play: _"Version code N has already been used"_                        | A code exists on a track fastlane doesn't read. Pass `version_code:` to the `build` lane. |
| Play: _"Only releases with status draft may be created on draft app"_ | App not yet published: set `PLAY_RELEASE_STATUS=draft` (A4).                              |
| Play: _"Package not found"_ / 403                                     | First upload not done (A6), or the service account lacks permissions (A7).                |
| Play: _"signed with the wrong key"_                                   | The bundle wasn't signed with the registered upload key. Check the keystore secret.       |
| Play: target API level error                                          | Bump `compileSdk`/`targetSdk` in `apps/android/app/build.gradle` (A2).                    |
| App crashes on launch in release only                                 | `libnativehelper` shim missing (ekrooh#45), or a 32-bit device (ekrooh#46).               |

## Local release build

```bash
cd apps/android
fastlane build                 # signed bundle, verified (needs keystore.properties)
fastlane internal              # build + upload to internal (needs the Play JSON key)
./gradlew :app:bundleRelease   # → app/build/outputs/bundle/release/app-release.aab
jarsigner -verify app/build/outputs/bundle/release/app-release.aab
```

Without `keystore.properties` (or the env vars) the bundle builds **unsigned**.
That's fine for checking the build, but Play won't accept it.
