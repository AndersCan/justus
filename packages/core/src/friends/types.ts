export type Friend = { identity: string; name: string };

export const FRIEND_NAME_MAX = 40;

export const FriendError = {
  INVALID_KEY: "justus.friends/invalid-key",
  NAME_REQUIRED: "justus.friends/name-required",
  NOT_FOUND: "justus.friends/not-found",
  WRITE_FAILED: "justus.friends/write-failed",
} as const;
