import { WORDS } from "./words";

/** The three-word check code both phones show for one identity key: "maple river stone". */
export function checkCode(
  identity: string,
  crypto: Pick<typeof import("bare-crypto"), "createHash">,
): string {
  const hash = Buffer.from(
    crypto.createHash("sha-256").update(`justus-check:${identity.toLowerCase()}`).digest("hex"),
    "hex",
  );
  return [0, 2, 4].map((offset) => WORDS[hash.readUInt16BE(offset) & 2047]).join(" ");
}
