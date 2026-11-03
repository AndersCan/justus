import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifest: Record<string, string[]> = JSON.parse(
  readFileSync(join(root, "docs/flows/manifest.json"), "utf8"),
);
const listed = Object.values(manifest).flat();

function machineFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : machineFiles(path);
    return entry.name.endsWith("-machine.ts") ? [relative(root, path)] : [];
  });
}

test("every machine file is in the flows manifest", () => {
  const found = ["apps/web/src", "apps/backend/src"].flatMap((dir) =>
    machineFiles(join(root, dir)),
  );
  expect(found.filter((file) => !listed.includes(file))).toEqual([]);
});

test("every manifest path exists", () => {
  expect(listed.filter((file) => !existsSync(join(root, file)))).toEqual([]);
});
