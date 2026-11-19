import { describe, expect, it } from "vite-plus/test";
import { listedPeople, nextWhoJoined, type ListedPerson } from "./who-joined";

const key = (n: string) => n.toLowerCase().padEnd(8, "0");
const p = (name: string, addedAt: number): ListedPerson => ({ key: key(name), name, addedAt });
const read = (self: string, people: ListedPerson[], admin = "Ada") => ({
  selfKey: key(self),
  adminKey: key(admin),
  people,
});
const names = (r: ReturnType<typeof nextWhoJoined>) => r?.whoJoined?.map((j) => j.name);

describe("who joined after this phone", () => {
  it("E1: names the person let in after Ben", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 0 },
      read("Ben", [p("Nils", 100), p("Ben", 200), p("Cy", 300)]),
    );
    expect(names(r)).toEqual(["Cy"]);
    expect(r?.joinedUpTo).toBe(300);
  });

  it("E2: Cy's own phone never names the people already in", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 0 },
      read("Cy", [p("Nils", 100), p("Ben", 200), p("Cy", 300)]),
    );
    expect(r).toBeUndefined();
  });

  it("E3: a phone not on the lists yet changes nothing", () => {
    expect(
      nextWhoJoined({ joinedUpTo: 0 }, read("Ben", [p("Nils", 100), p("Cy", 300)])),
    ).toBeUndefined();
  });

  it("E4: an album from before this change starts silently", () => {
    const r = nextWhoJoined({}, read("Ben", [p("Nils", 100), p("Ben", 200), p("Cy", 300)]));
    expect(r).toEqual({ joinedUpTo: 300 });
  });

  it("E5: a dismissed line does not come back", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 300 },
      read("Ben", [p("Nils", 100), p("Ben", 200), p("Cy", 300)]),
    );
    expect(r).toBeUndefined();
  });

  it("E7: someone let in again is named again", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 300 },
      read("Ben", [p("Nils", 100), p("Ben", 200), p("Cy", 500)]),
    );
    expect(names(r)).toEqual(["Cy"]);
    expect(r?.joinedUpTo).toBe(500);
  });

  it("E8: a placeholder name is skipped and never waited for", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 200 },
      read("Ben", [p("Ben", 200), p("New member", 300), p("Di", 400)]),
    );
    expect(names(r)).toEqual(["Di"]);
    expect(r?.joinedUpTo).toBe(400);
  });

  it("E9: several people read in join order", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 200 },
      read("Ben", [p("Ben", 200), p("Di", 400), p("Cy", 300)]),
    );
    expect(names(r)).toEqual(["Cy", "Di"]);
  });

  it("E9: the same join time reads in key order", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 200 },
      read("Ben", [p("Ben", 200), p("Di", 300), p("Cy", 300)]),
    );
    expect(names(r)).toEqual(["Cy", "Di"].sort((a, b) => (key(a) < key(b) ? -1 : 1)));
  });

  it("E10: the Admin never joins", () => {
    const r = nextWhoJoined({ joinedUpTo: 200 }, read("Ben", [p("Ben", 200), p("Ada", 900)]));
    expect(r).toBeUndefined();
  });

  it("E11: a name already on the line is not added twice", () => {
    const r = nextWhoJoined(
      { joinedUpTo: 300, whoJoined: [{ key: key("Cy"), name: "Cy" }] },
      read("Ben", [p("Ben", 200), p("Cy", 500)]),
    );
    expect(names(r)).toEqual(["Cy"]);
    expect(r?.joinedUpTo).toBe(500);
  });

  it("lists Collaborators then Viewers, once each", () => {
    const people = listedPeople(
      { version: 1, members: { a: { key: "a", name: "A", addedAt: 1 } } },
      {
        a: { key: "a", name: "A", addedAt: 2 },
        b: { key: "b", name: "B", addedAt: 3 },
      },
    );
    expect(people.map((x) => [x.key, x.addedAt])).toEqual([
      ["a", 1],
      ["b", 3],
    ]);
  });
});
