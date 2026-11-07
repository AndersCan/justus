import { RealClock } from "@mantaq/core";
import { gateway } from "../../gateway";
import { closePicker, createAddFriendActor, openPicker, pickFriend } from "./add-friend-machine";

export const addFriendActor = createAddFriendActor({
  clock: RealClock(),
  port: { offerAlbum: (folderId, identity) => gateway.offerAlbum(folderId, identity) },
});

export const addFriend = {
  openPicker: (input: Parameters<typeof openPicker.create>[0]) =>
    addFriendActor.send(openPicker.create(input)),
  pickFriend: (identity: string) => addFriendActor.send(pickFriend.create({ identity })),
  closePicker: () => addFriendActor.send(closePicker.create()),
};
