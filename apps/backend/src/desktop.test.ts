import { describe, expect, it } from "vite-plus/test";
import { parseHandoffFd } from "./desktop";

describe("parseHandoffFd", () => {
  it("reads the fd from the labeled token", () => {
    expect(parseHandoffFd(["bare", "x.bundle", "port=0", "handoff=4"])).toBe(4);
  });
  it("is undefined without the token", () => {
    expect(parseHandoffFd(["bare", "x.bundle"])).toBeUndefined();
  });
  it("rejects stdio fds and garbage", () => {
    expect(parseHandoffFd(["handoff=2"])).toBeUndefined();
    expect(parseHandoffFd(["handoff=abc"])).toBeUndefined();
    expect(parseHandoffFd(["handoff="])).toBeUndefined();
  });
});
