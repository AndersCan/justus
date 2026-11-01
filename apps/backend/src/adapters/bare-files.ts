import type { Files, Paths } from "../ports/files";
import fs from "bare-fs";
import path from "bare-path";

export function createBareFiles(): { fs: Files; path: Paths } {
  return { fs, path };
}
