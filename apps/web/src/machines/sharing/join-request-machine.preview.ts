import "../../design/justus/design.css";
import "../../tokens.css";
import "../../reset.css";
import "uno.css";
import type { JoinView } from "./join-request";
import { render } from "lit-html";
import { renderJoinSheet } from "../../views/join-sheet";

const nothing = () => {};
const actions = {
  dismissExpired: nothing,
  closeStoppedLink: nothing,
  notNow: nothing,
  askToJoin: nothing,
  cancelRequest: nothing,
  closeWaiting: nothing,
  dismissDecline: nothing,
  askAgain: nothing,
};

/** The join sheet for one state of the walk, without the albums list (no check code, no "wasn't answered" line). */
export default function preview(
  element: HTMLElement,
  state: { name: JoinView["state"]; payload: JoinView["invite"]; context: { error: string } },
) {
  render(
    renderJoinSheet(
      { state: state.name, invite: state.payload, error: state.context.error },
      actions,
    ),
    element,
  );
}
