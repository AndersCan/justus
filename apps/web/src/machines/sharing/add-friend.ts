import { RealClock } from "@mantaq/core";
import { gateway } from "../../gateway";
import {
  closePicker,
  createAddFriendActor,
  openPicker,
  pickRole,
  toggleFriend,
  type FriendRole,
} from "./add-friend-machine";

export const addFriendActor = createAddFriendActor({
  clock: RealClock(),
  port: { offerAlbum: (folderId, identity, role) => gateway.offerAlbum(folderId, identity, role) },
});

export const addFriend = {
  openPicker: (input: Parameters<typeof openPicker.create>[0]) =>
    addFriendActor.send(openPicker.create(input)),
  toggleFriend: (identity: string) => addFriendActor.send(toggleFriend.create({ identity })),
  pickRole: (role: FriendRole) => addFriendActor.send(pickRole.create({ role })),
  closePicker: () => addFriendActor.send(closePicker.create()),
};
