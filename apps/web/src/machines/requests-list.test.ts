import { describe, expect, test } from "vite-plus/test";
import { removeRequestFromList } from "./requests-list";
import type { JoinRequest } from "@justus/core";

function req(folderId: string, requesterKey: string, requesterName = "device"): JoinRequest {
  return {
    folderId,
    requesterKey,
    requesterName,
    folderName: `folder ${folderId}`,
    shareKey: `share-${folderId}`,
    requestedAt: 0,
  };
}

describe("removeRequestFromList (issue #45)", () => {
  test("drops only the request matching both folderId and requesterKey", () => {
    const requests = [
      req("A", "key1"),
      req("B", "key1"), // same requester, different folder — must survive
      req("A", "key2"),
    ];
    const out = removeRequestFromList(requests, "A", "key1");
    expect(out).toEqual([req("B", "key1"), req("A", "key2")]);
  });

  test("does not drop other folders of the same requester", () => {
    const requests = [req("A", "key1"), req("B", "key1"), req("C", "key1")];
    const out = removeRequestFromList(requests, "B", "key1");
    expect(out.map((r) => `${r.folderId}:${r.requesterKey}`).sort()).toEqual(["A:key1", "C:key1"]);
  });

  test("is a no-op when nothing matches", () => {
    const requests = [req("A", "key1")];
    expect(removeRequestFromList(requests, "A", "other")).toEqual(requests);
    // Original array is not mutated.
    expect(requests).toHaveLength(1);
  });
});
