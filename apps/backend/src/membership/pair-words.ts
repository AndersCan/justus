import { WORDS } from "./words";

/** The four words both phones show for a pair of identity keys, in either order: "early steel produce clap". */
export function pairWords(
  a: string,
  b: string,
  crypto: Pick<typeof import("bare-crypto"), "createHash">,
): string {
  const [lo, hi] = [a.toLowerCase(), b.toLowerCase()].sort();
  const hash = Buffer.from(
    crypto.createHash("sha-256").update(`justus-pair:${lo}:${hi}`).digest("hex"),
    "hex",
  );
  return [0, 2, 4, 6].map((offset) => WORDS[hash.readUInt16BE(offset) & 2047]).join(" ");
}
