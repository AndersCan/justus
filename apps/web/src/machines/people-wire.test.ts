import { expect, test, vi } from "vite-plus/test";
import { peopleActor, wirePeopleToRequests } from "./people-machine";
import { requestsActor } from "./requests-machine";

test("only an opened sheet asks for requests, not the other people outputs", () => {
  let listener: (e: { type: string; payload?: unknown }) => void = () => {};
  const people = {
    on: (_: "output", options: { fn: typeof listener }) => {
      listener = options.fn;
      return () => {};
    },
  };
  const refresh = vi.fn();
  wirePeopleToRequests(people as never, { refresh });
  listener({ type: "MEMBER_REMOVED", payload: { memberKey: "k" } });
  listener({ type: "INVITE_WITHDRAWN", payload: {} });
  expect(refresh).not.toHaveBeenCalled();
  listener({ type: "SHEET_OPENED" });
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("the app's People sheet asks the app's requests machine for requests", () => {
  expect(requestsActor.snapshot().path[0]).toBe("requestsNotLoaded");
  peopleActor.send({ type: "OPEN" } as never);
  expect(requestsActor.snapshot().path[0]).not.toBe("requestsNotLoaded");
});
