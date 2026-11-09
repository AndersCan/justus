import { describe, expect, test } from "vite-plus/test";
import type { AskSummary, FolderSummary } from "@justus/core";
import { classifyInvite } from "./classify-invite";

const folder = (id: string, role: FolderSummary["role"], code?: string) =>
  ({ id, role, invite: code ? { code, owner: "o" } : undefined }) as FolderSummary;
const ask = (code: string, status: AskSummary["status"]) => ({ code, status }) as AskSummary;

describe("classifyInvite", () => {
  test("an unknown code is new", () => {
    expect(classifyInvite("c1", [folder("f1", "creator", "c2")], [ask("c3", "waiting")])).toEqual({
      kind: "new",
    });
  });
  test("the code of an album I made is own", () => {
    expect(classifyInvite("c1", [folder("f1", "creator", "c1")], [])).toEqual({
      kind: "own",
      folderId: "f1",
    });
  });
  test("the code an album was joined through is member, for any joined role", () => {
    for (const role of ["member", "reader"] as const) {
      expect(classifyInvite("c1", [folder("f2", role, "c1")], [])).toEqual({
        kind: "member",
        folderId: "f2",
      });
    }
  });
  test("an ask told the link is off is turnedOff, but an album with that code wins", () => {
    expect(classifyInvite("c1", [], [ask("c1", "linkOff")])).toEqual({ kind: "turnedOff" });
    expect(classifyInvite("c1", [folder("f2", "member", "c1")], [ask("c1", "linkOff")])).toEqual({
      kind: "member",
      folderId: "f2",
    });
  });

  test("a moved or new-key album's code is still member", () => {
    for (const kind of ["moved", "newKey"] as const) {
      const f = { ...folder("f2", "member", "c1"), notice: { kind } } as FolderSummary;
      expect(classifyInvite("c1", [f], [])).toEqual({ kind: "member", folderId: "f2" });
    }
  });

  test("a removed album's code is turnedOff, for member and reader", () => {
    for (const role of ["member", "reader"] as const) {
      const removed = { ...folder("f2", role, "c1"), notice: { kind: "removed" } } as FolderSummary;
      expect(classifyInvite("c1", [removed], [])).toEqual({ kind: "turnedOff" });
      expect(classifyInvite("c2", [removed], [])).toEqual({ kind: "new" });
    }
  });

  test("a waiting ask is waiting; a declined ask can be asked again", () => {
    expect(classifyInvite("c1", [], [ask("c1", "waiting")])).toEqual({ kind: "waiting" });
    expect(classifyInvite("c1", [], [ask("c1", "declined")])).toEqual({ kind: "new" });
  });
  test("an album wins over a stale ask", () => {
    expect(classifyInvite("c1", [folder("f2", "member", "c1")], [ask("c1", "waiting")])).toEqual({
      kind: "member",
      folderId: "f2",
    });
  });
});
