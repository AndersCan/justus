/**
 * The swarm topic an Admin serves for an album's invite code. Only the Admin's
 * device listens here, so a link holder meets nobody else: members and their
 * identity drives stay off this topic.
 */
export function inviteTopic(
  code: string,
  crypto: Pick<typeof import("bare-crypto"), "createHash">,
): Buffer {
  return Buffer.from(
    crypto.createHash("sha-256").update(`justus-invite:${code}`).digest("hex"),
    "hex",
  );
}
