import { machine } from "@mantaq/core";
import { appLockMachine } from "./app-lock-machine";
import { foldersMachine, wireFoldersToSync } from "./folders-machine";
import { friendsMachine } from "./friends-machine";
import { galleryMachine } from "./gallery-machine";
import { lightboxMachine } from "./lightbox-machine";
import { logsMachine } from "./logs-machine";
import { onboardingMachine, wireOnboardingToFolders } from "./onboarding-machine";
import { peopleMachine, wirePeopleToRequests } from "./people-machine";
import { prefsMachine } from "./prefs-machine";
import { reachMachine, wireReachToSync } from "./reach-hint-machine";
import { requestsMachine, refresh } from "./requests-machine";
import { routerMachine } from "./router-machine";
import { seenMachine } from "./seen-machine";
import { pickedPhotosMachine } from "./picked-photos-machine";
import { sharedPhotosMachine } from "./shared-photos-machine";
import { addFriendMachine } from "./sharing/add-friend-machine";
import { friendOfferMachine } from "./sharing/friend-offer-machine";
import { inviteLinkMachine } from "./sharing/invite-link-machine";
import { joinRequestMachine } from "./sharing/join-request-machine";
import { wireAsksToJoin } from "./sharing/join-request";
import { syncMachine } from "./sync-machine";

/** Every machine in the app, wired as the app wires them, so one board draws the whole app.
 * The router is the root; the other eighteen sit beside it by name. */
export const justusMachine = machine("justus", {
  create: ({ clock }) => {
    const folders = foldersMachine.create();
    const sync = syncMachine.create();
    const onboarding = onboardingMachine.create();
    const people = peopleMachine.create();
    const requests = requestsMachine.create();
    const reach = reachMachine.create({ clock });
    const join = joinRequestMachine.create({ clock });
    wireOnboardingToFolders(onboarding, folders);
    wireFoldersToSync(folders, sync);
    wireReachToSync(reach, sync);
    wirePeopleToRequests(people, { refresh: () => requests.send(refresh.create()) });
    wireAsksToJoin(folders, join);
    return {
      actor: routerMachine.create(),
      appLock: appLockMachine.create(),
      folders,
      friends: friendsMachine.create(),
      gallery: galleryMachine.create(),
      lightbox: lightboxMachine.create(),
      logs: logsMachine.create(),
      onboarding,
      people,
      prefs: prefsMachine.create(),
      reach,
      seen: seenMachine.create({}),
      sharedPhotos: sharedPhotosMachine.create({}),
      pickedPhotos: pickedPhotosMachine.create(),
      requests,
      sync,
      addFriend: addFriendMachine.create(),
      friendOffer: friendOfferMachine.create({ clock }),
      inviteLink: inviteLinkMachine.create({ clock }),
      join,
    };
  },
});
