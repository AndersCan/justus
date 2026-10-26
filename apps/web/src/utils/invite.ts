/** An invite to an album: the 64-hex share key plus unsigned hints the joiner
 * sees before consenting. The hints are only labels; the key is what matters. */
export type Invite = {
  key: string;
  /** Album name. */
  name?: string;
  /** The Admin's display name. */
  admin?: string;
  /** Member count when the invite was made. */
  members?: number;
};

const KEY = "[0-9a-f]{64}";
const LINK = new RegExp(`justus://join/(${KEY})(?:\\?([^\\s]*))?`, "i");
const RAW_KEY = new RegExp(`^${KEY}$`, "i");

export function buildInvite(invite: Invite): string {
  const params = new URLSearchParams();
  if (invite.name) params.set("n", invite.name);
  if (invite.admin) params.set("a", invite.admin);
  if (invite.members != null) params.set("m", String(invite.members));
  const query = params.toString();
  return `justus://join/${invite.key.toLowerCase()}${query ? `?${query}` : ""}`;
}

/** Accepts an invite link (anywhere in the text, so a shared message works) or
 * a bare 64-hex key, spaces allowed. Returns null when neither is present. */
export function parseInvite(text: string): Invite | null {
  const link = LINK.exec(text);
  if (link) {
    const params = new URLSearchParams(link[2] ?? "");
    const members = Number(params.get("m"));
    return {
      key: link[1].toLowerCase(),
      name: params.get("n") || undefined,
      admin: params.get("a") || undefined,
      members: params.has("m") && Number.isInteger(members) && members >= 0 ? members : undefined,
    };
  }
  const bare = text.replace(/\s+/g, "");
  return RAW_KEY.test(bare) ? { key: bare.toLowerCase() } : null;
}
