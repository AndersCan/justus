import { render } from "lit-html";
import type { JoinView } from "./join-request";
import type { JoinInvite } from "../../utils/invite-link";
import { renderJoinSheet } from "../../views/join-sheet";
import "../../design/justus/tokens/theme.css";
import "../../tokens.css";
import "../../reset.css";
import "uno.css";

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
  state: { name: JoinView["state"]; payload: JoinInvite | null; context: { error: string } },
) {
  render(
    renderJoinSheet(
      { state: state.name, invite: state.payload, error: state.context.error },
      actions,
    ),
    element,
  );
}
