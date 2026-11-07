import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { get } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vite-plus/test";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const script = join(root, "scripts/flows-dev.mjs");
let child: ChildProcess | undefined;

afterAll(() => {
  child?.kill();
});

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

function firstUrl(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no flows:dev URL line in 60 s")), 60_000);
    let buffer = "";
    proc.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /^flows:dev: (http\S+__mantaq\/)$/m.exec(buffer);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`flows:dev exited early (${code})`));
    });
  });
}

test("a machine file opens the live page with its recorded runs", async () => {
  child = spawn("node", [script, "apps/web/src/machines/sharing/invite-link-machine.ts"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await firstUrl(child);
  const flow = (await getJson(`${url}viz.json`)) as {
    machines: { id: string; runs?: unknown[] }[];
  };
  const machine = flow.machines.find((m) => m.id === "inviteLink");
  expect(machine?.runs?.length).toBeGreaterThan(0);
}, 90_000);

test("an unknown target exits 1 and lists the features", () => {
  const result = spawnSync("node", [script, "nope"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Features: first-run");
});
