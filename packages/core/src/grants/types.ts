export type GrantState = "granted" | "revoked" | "declined" | "undecided";

export type GrantRecord = {
  peerId: string;
  serveTo: GrantState;
  /** Peer we receive from, when this device was invited into their album. */
  serveFrom?: string;
  /** Peer that sent the invite receipt (the inviter auto-shares to us). */
  invitedBy?: string;
  /** Verified invite receipt payload. Presence marks the peer as known. */
  receipt?: string;
  /** Volatile runtime presence — not persisted. */
  online?: boolean;
  lastSeenAt?: number;
  /** Set the first time a peer is seen holding our content without a receipt;
   * drives the once-daily unknown-holder prompt. */
  unknownHolderSince?: number;
  /** Last time the unknown-holder prompt was shown for this peer. */
  lastPromptedAt?: number;
  /** Decline is terminal: the prompt never re-shows for this peer. */
  declinedTerminal?: boolean;
  lastChangedAt: number;
};
