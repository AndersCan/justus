/**
 * Local file access (#200, ADR 0002): the slice of `bare-fs` and `bare-path`
 * the backend uses. The app talks to this; `src/adapters/bare-files.ts`
 * supplies the real thing and `test/contracts/files.contract.ts` pins the
 * behaviour any implementation must have.
 */
export type Files = Pick<
  typeof import("bare-fs"),
  | "createReadStream"
  | "createWriteStream"
  | "existsSync"
  | "lstatSync"
  | "mkdirSync"
  | "readFileSync"
  | "readdirSync"
  | "readlinkSync"
  | "renameSync"
  | "rmSync"
  | "statSync"
  | "unlinkSync"
  | "writeFileSync"
>;

export type Paths = Pick<
  typeof import("bare-path"),
  "basename" | "dirname" | "extname" | "join" | "resolve" | "sep"
>;
