import type { RoleChange } from "@justus/core";
import { copy } from "../copy/copy";
import { toast } from "./toast";

export type RoleChangeIn = RoleChange & { folderId: string };

/** The role message for a change. */
export function roleToastText(change: RoleChangeIn): { text: string } {
  const album = change.albumName;
  const name = change.adminName;
  if (change.to === "reader") {
    return {
      text:
        name === undefined
          ? copy("role_toast.the_admin_made_you_a_viewer", { album })
          : copy("role_toast.made_you_a_viewer", { name, album }),
    };
  }
  return {
    text:
      name === undefined
        ? copy("role_toast.the_admin_made_you_a_collaborator", { album })
        : copy("role_toast.made_you_a_collaborator", { name, album }),
  };
}

/** Handles role pushes. An object so tests can spy on it. */
export const roleToast = {
  changed(change: RoleChangeIn): void {
    if (change.from === change.to) return;
    toast(roleToastText(change).text);
  },
};
