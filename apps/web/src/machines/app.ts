import type { Clock } from "@mantaq/core";
import { classifyInvite } from "../utils/classify-invite";
import { createAppLockActor } from "./app-lock-machine";
import { createFoldersActor, wireFoldersToSync } from "./folders-machine";
import { createFriendsActor } from "./friends-machine";
import { createGalleryActor } from "./gallery-machine";
import { createLightboxActor } from "./lightbox-machine";
import { createLogsActor } from "./logs-machine";
import { createOnboardingActor, wireOnboardingToFolders } from "./onboarding-machine";
import { createPeopleActor, wirePeopleToRequests } from "./people-machine";
import { createPrefsActor } from "./prefs-machine";
import { createReachActor, wireReachToSync } from "./reach-hint-machine";
import { createRequestsActor, refresh } from "./requests-machine";
import { createRouterActor } from "./router-machine";
import { createAddFriendActor } from "./sharing/add-friend-machine";
import { createFriendOfferActor } from "./sharing/friend-offer-machine";
import { createInviteLinkActor } from "./sharing/invite-link-machine";
import { createJoinRequestActor } from "./sharing/join-request-machine";
import { wireAsksToJoin } from "./sharing/join-request";
import { createSyncActor } from "./sync-machine";

/** Every machine in the app, wired as the app wires them, so one board draws the whole app.
 * The router is the root; the other sixteen sit beside it by name. */
export function createJustus(options: { clock: Clock }) {
  const { clock } = options;
  const folders = createFoldersActor({ clock });
  const sync = createSyncActor({ clock });
  const onboarding = createOnboardingActor({ clock });
  const people = createPeopleActor({ clock });
  const requests = createRequestsActor({ clock });
  const reach = createReachActor({ clock });
  const join = createJoinRequestActor({
    clock,
    known: (invite) =>
      classifyInvite(
        invite.code,
        folders.snapshot().context.folders,
        folders.snapshot().context.asks,
      ),
    asked: (code) => folders.snapshot().context.asks.find((a) => a.code === code),
  });
  wireOnboardingToFolders(onboarding, folders);
  wireFoldersToSync(folders, sync);
  wireReachToSync(reach, sync);
  wirePeopleToRequests(people, { refresh: () => requests.send(refresh.create()) });
  wireAsksToJoin(folders, join);
  return {
    actor: createRouterActor({ clock, page: undefined }),
    appLock: createAppLockActor({ clock }),
    folders,
    friends: createFriendsActor({ clock }),
    gallery: createGalleryActor({ clock }),
    lightbox: createLightboxActor({ clock }),
    logs: createLogsActor({ clock }),
    onboarding,
    people,
    prefs: createPrefsActor({ clock }),
    reach,
    requests,
    sync,
    addFriend: createAddFriendActor({ clock }),
    friendOffer: createFriendOfferActor({ clock }),
    inviteLink: createInviteLinkActor({ clock }),
    join,
  };
}
