import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { definePlugin, MessageProtocol, MessageType, type EventSpec } from "@ekrooh/bare/core";
import { createWorkletRuntime } from "@ekrooh/bare/runtime";
import { lockSpecs } from "@justus/core";
import { createLockPluginStub } from "./lock-plugin";

// The bare-* builtins only exist in the Bare runtime; map them to Node ones.
vi.mock("bare-fs", async () => ({ default: await import("node:fs") }));
vi.mock("bare-path", async () => ({ default: await import("node:path") }));
vi.mock("bare-http1", async () => ({ default: await import("node:http") }));
vi.mock("bare-os", async () => ({ default: await import("node:os") }));
vi.mock("bare-encoding", async () => await import("node:util"));
// blake2b-256 is not in OpenSSL; any stable digest serves the loopback gate.
vi.mock("bare-crypto", async () => {
  const crypto = await import("node:crypto");
  return {
    default: {
      ...crypto,
      createHash: (algorithm: string) =>
        crypto.createHash(algorithm === "blake2b-256" ? "sha256" : algorithm),
    },
  };
});
vi.mock("bare-ws", () => ({ default: { Server: { handshake() {} }, Socket: class {} } }));
vi.mock("bare-inspect", () => ({ default: String }));
vi.mock("bare-structured-clone", () => ({ default: structuredClone }));

const protocol = new MessageProtocol({
  encode: (str) => new Uint8Array(Buffer.from(str)),
  decode: (bytes) => Buffer.from(bytes).toString(),
});

type Header = Record<string, any>;

/** Runs lock.setEnabled through a worklet runtime whose host answers after delayMs. */
async function runPromptAnsweredAfter(
  plugin: ReturnType<typeof createLockPluginStub>,
  delayMs: number,
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const ipc = Object.assign(new EventEmitter(), {
    write: vi.fn((_data: unknown) => true),
    resume() {},
  });
  vi.stubGlobal("BareKit", { IPC: ipc });
  const runtime = createWorkletRuntime({ port: 0, plugins: [plugin] });
  const sent = (): Header[] =>
    ipc.write.mock.calls.map((c) => protocol.decode(new Uint8Array(c[0] as Buffer)).header);
  const nextSent = async (type: string): Promise<Header> => {
    await vi.waitFor(() => expect(sent().map((h) => h.type)).toContain(type), { timeout: 1000 });
    return sent().find((h) => h.type === type) as Header;
  };
  const send = (header: Header) =>
    ipc.emit("data", Buffer.from(protocol.encode(MessageType.ENVELOPE, header as never, null)));

  send({
    type: "INVOKE_REQUEST",
    pluginId: "justus.lock",
    event: "lock.setEnabled",
    requestId: "r1",
  });
  const query = await nextSent("HOST_CAPABILITIES_QUERY");
  send({
    type: "HOST_CAPABILITIES_RESPONSE",
    requestId: query.requestId,
    capabilities: [
      {
        pluginId: "justus.lock",
        capabilities: ["lock"],
        events: ["lock.setEnabled"],
        runtimes: ["ios"],
      },
    ],
  });
  const hostInvoke = await nextSent("HOST_INVOKE_REQUEST");
  // The person looks at the Face ID prompt for delayMs, then confirms.
  await vi.advanceTimersByTimeAsync(delayMs);
  send({
    type: "HOST_INVOKE_RESPONSE",
    requestId: hostInvoke.requestId,
    pluginId: "justus.lock",
    event: "lock.setEnabled",
    result: { enabled: true },
  });
  const response = await nextSent("INVOKE_RESPONSE");
  runtime.close();
  return response;
}

describe("lock plugin stub", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("a host answer after 31 s resolves lock.setEnabled", async () => {
    const response = await runPromptAnsweredAfter(createLockPluginStub(), 31_000);
    expect(response.requestId).toBe("r1");
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ enabled: true });
  });

  test("the host leg waits the prompt's 300 s, no more", async () => {
    const early = await runPromptAnsweredAfter(createLockPluginStub(), 299_000);
    expect(early.error).toBeUndefined();
    expect(early.result).toEqual({ enabled: true });
    const late = await runPromptAnsweredAfter(createLockPluginStub(), 301_000);
    expect(JSON.stringify(late.error)).toContain("TIMEOUT");
  });

  test("without hostTimeoutMs the same answer fails with TIMEOUT", async () => {
    const { hostTimeoutMs: _omit, ...setEnabled } = lockSpecs.setEnabled as EventSpec<any, any>;
    const plugin = definePlugin(
      "justus.lock",
      { status: lockSpecs.status, setEnabled },
      { capabilities: ["lock"] },
    );
    const response = await runPromptAnsweredAfter(plugin as never, 31_000);
    expect(JSON.stringify(response.error)).toContain("TIMEOUT");
  });
});
