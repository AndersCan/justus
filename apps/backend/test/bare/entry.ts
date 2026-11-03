/**
 * Bare entry: runs every shared p2p scenario with the real bare-* deps.
 * Started by `scripts/test-bare.mjs` as `bare <bundle> dir=<scratch> [only=<substr>]`.
 * Exits non-zero if any scenario fails.
 */
import { bareNet, barePeerWorlds, bareWorld } from "./net.ts";
import { cases } from "../contracts/drive-store.contract.ts";
import { cases as peerCases } from "../contracts/peer-network.contract.ts";
import { cases as filesCases } from "../contracts/files.contract.ts";
import { cases as lazyMediaCases } from "../contracts/lazy-media.contract.ts";
import { bareLazyMedia } from "./lazy-media.ts";
import { createBareFiles } from "../../src/adapters/bare-files.ts";
import bareFs from "bare-fs";
import { makeCheck, scenarios } from "../p2p-scenarios.ts";
import { createMembershipActor } from "../../src/membership/membership-machine.ts";
import { VirtualClock } from "@mantaq/core";
import { Either } from "@mantaq/utils";

declare const Bare: { argv: string[]; exit(code?: number): never };

const arg = (name: string) =>
  Bare.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const root = arg("dir");
if (!root) {
  console.error("test-bare: missing dir=<scratch>");
  Bare.exit(2);
}
const only = arg("only");
const SCENARIO_TIMEOUT_MS = 60_000;

let failed = 0;
for (const s of scenarios) {
  if (only && !s.name.includes(only)) continue;
  const started = Date.now();
  const net = await bareNet(`${root}/${scenarios.indexOf(s)}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      s.run(net, makeCheck()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`scenario timed out after ${SCENARIO_TIMEOUT_MS}ms`)),
          SCENARIO_TIMEOUT_MS,
        );
      }),
    ]);
    console.log(`ok   ${s.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${s.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } finally {
    clearTimeout(timer);
    // Best effort: a hung teardown must not mask the verdict.
    await Promise.race([net.destroy(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => {});
  }
}
const CASE_TIMEOUT_MS = 30_000;
const worlds = await bareWorld(`${root}/drive`);
for (const c of cases) {
  if (only && !c.name.includes(only)) continue;
  const started = Date.now();
  const world = worlds.world();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      c.run(world, makeCheck()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`case timed out after ${CASE_TIMEOUT_MS}ms`)),
          CASE_TIMEOUT_MS,
        );
      }),
    ]);
    console.log(`ok   drive-store: ${c.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(
      `FAIL drive-store: ${c.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
const files = createBareFiles();
for (const c of filesCases) {
  if (only && !c.name.includes(only)) continue;
  const started = Date.now();
  const dir = `${root}/files-${filesCases.indexOf(c)}`;
  files.fs.mkdirSync(dir, { recursive: true });
  try {
    await c.run(
      { ...files, dir, symlink: (target, link) => bareFs.symlinkSync(target, link) },
      makeCheck(),
    );
    console.log(`ok   files: ${c.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(
      `FAIL files: ${c.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  }
}
const lazyMedia = await bareLazyMedia();
for (const c of lazyMediaCases) {
  if (only && !c.name.includes(only)) continue;
  const started = Date.now();
  const dir = `${root}/lazy-media-${lazyMediaCases.indexOf(c)}`;
  files.fs.mkdirSync(dir, { recursive: true });
  try {
    await c.run(lazyMedia.world({ ...files, dir }), makeCheck());
    console.log(`ok   lazy-media: ${c.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(
      `FAIL lazy-media: ${c.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  }
}
await Promise.race([lazyMedia.destroy(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => {});
await Promise.race([worlds.destroy(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => {});
const peerWorlds = await barePeerWorlds();
for (const c of peerCases) {
  if (only && !c.name.includes(only)) continue;
  const started = Date.now();
  const world = peerWorlds.world();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      c.run(world, makeCheck()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`case timed out after ${CASE_TIMEOUT_MS}ms`)),
          CASE_TIMEOUT_MS,
        );
      }),
    ]);
    console.log(`ok   peer-network: ${c.name} (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(
      `FAIL peer-network: ${c.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
    await Promise.race([world.close(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => {});
  }
}
await Promise.race([peerWorlds.destroy(), new Promise((r) => setTimeout(r, 5_000))]).catch(
  () => {},
);
{
  const started = Date.now();
  try {
    const entry = {
      requesterKey: "a".repeat(64),
      requesterName: "Ann",
      shareKey: "b".repeat(64),
      folderName: "Trip",
      requestedAt: 1,
    };
    const actor = createMembershipActor({
      clock: VirtualClock(),
      port: {
        addMember: () => Promise.resolve(Either.right({})),
        removeMember: () => Promise.resolve(Either.right({})),
      },
      memberKey: entry.requesterKey,
    });
    const states: string[] = [];
    actor.send({ type: "requestSent", payload: entry });
    await actor.settled();
    states.push(String(actor.state.name));
    actor.send({ type: "approve" });
    await actor.settled();
    states.push(String(actor.state.name));
    actor.send({ type: "remove" });
    await actor.settled();
    states.push(String(actor.state.name));
    const got = states.join(",");
    if (got !== "requestPending,enrolled,removed") throw new Error(`unexpected states ${got}`);
    console.log(`ok   membership-machine: request, approve, remove (${Date.now() - started}ms)`);
  } catch (e) {
    failed++;
    console.log(
      `FAIL membership-machine: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  }
}
console.log(failed ? `${failed} scenario(s) or case(s) failed` : "all scenarios passed");
Bare.exit(failed ? 1 : 0);
