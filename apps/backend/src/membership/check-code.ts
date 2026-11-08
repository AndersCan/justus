/** The 8-digit check code both phones show for one identity key: "4821 9035". */
export function checkCode(
  identity: string,
  crypto: Pick<typeof import("bare-crypto"), "createHash">,
): string {
  const hash = Buffer.from(
    crypto.createHash("sha-256").update(`justus-check:${identity.toLowerCase()}`).digest("hex"),
    "hex",
  );
  const digits = String(hash.readUInt32BE(0) % 100_000_000).padStart(8, "0");
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}
