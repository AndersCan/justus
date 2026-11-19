import { html, nothing, type TemplateResult } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type { JoinView } from "../machines/sharing/join-request";
import { EXPIRED_LINK, expiredBody } from "../machines/sharing/join-request-machine";
import { copy, t } from "../copy/copy";
import { linkNamedOtherAlbum, ownerShown } from "../utils/invite-link";
import { modalDialog } from "./modal-dialog";

export type JoinSheetActions = {
  dismissExpired(): void;
  closeStoppedLink(): void;
  notNow(): void;
  askToJoin(): void;
  cancelRequest(): void;
  closeWaiting(): void;
  dismissDecline(): void;
  askAgain(): void;
};

export type JoinSheetLines = {
  /** Under a stopped-link title when the caller knows this phone asked; omitted = no line. */
  asked?: unknown;
  /** The three-word check code under the waiting text; omitted = no line. */
  checkCode?: unknown;
};

/** What a stopped-link sheet says, or null for a state that is not one. `askedLine`: add "Your request wasn't answered." when this phone has an ask for the code that is not closed. */
function stoppedSheet(
  state: string,
  owner: string,
  Owner: string,
): { title: string; body: string; askedLine: boolean } | null {
  switch (state) {
    case "linkTurnedOffByAdmin":
      return {
        title: copy("join_request.owner_turned_off_this_link", { owner: Owner }),
        body: copy("join_request.ask_owner_for_a_new_link", { owner }),
        askedLine: true,
      };
    case "linkReplacedByAdmin":
      return {
        title: copy("join_request.owner_replaced_this_link", { owner: Owner }),
        body: copy("join_request.ask_owner_for_the_new_link", { owner }),
        askedLine: true,
      };
    case "albumDeletedByAdmin":
      return {
        title: copy("join_request.owner_deleted_this_album", { owner: Owner }),
        body: copy("join_request.nothing_to_join_any_more"),
        askedLine: false,
      };
    case "linkStoppedForUnknownReason":
      return {
        title: copy("join_request.this_invite_link_no_longer"),
        body: expiredBody(owner),
        askedLine: false,
      };
    default:
      return null;
  }
}

const joinModal = modalDialog();

const WAITING_LINE_ID = "join-sheet-waiting-line";

function sheet(label: string, body: unknown, describedBy?: string) {
  return html`<dialog
    class="ui-sheet-dialog"
    aria-label=${label}
    aria-describedby=${describedBy ?? nothing}
    ${ref(joinModal)}
  >
    <div class="justus-sheet ui-sheet">${body}</div>
  </dialog>`;
}

/** The joiner's screens: ask, waiting, not accepted. Draws from the view alone, so it can be previewed.
 * No photos or counts: names come only from the Admin's phone. */
export function renderJoinSheet(
  view: JoinView,
  actions: JoinSheetActions,
  lines: JoinSheetLines = {},
): TemplateResult | null {
  const { state, invite, error } = view;
  if (
    state === "noInviteOpen" ||
    state === "showingWelcome" ||
    state === "holdingInviteUntilWelcomeEnds" ||
    state === "showingLinkProblem" ||
    state === "joinedAlbum" ||
    state === "alreadyInAlbum" ||
    state === "checkingPastedLink" ||
    state === "sendingPastedRequest" ||
    !invite
  )
    return null;
  const name = invite.ownerName;
  const owner = ownerShown(name, "mid");
  const Owner = ownerShown(name, "start");
  if (state === "linkExpired") {
    return sheet(
      EXPIRED_LINK,
      html`<h3 class="break-words text-base font-semibold text-fg">${EXPIRED_LINK}</h3>
        <p class="mt-3 text-sm text-fg">${expiredBody(name)}</p>
        <div class="mt-4 flex justify-end">
          <button
            class="ui-btn-primary"
            data-dismiss
            autofocus
            @click=${() => actions.dismissExpired()}
          >
            ${t("invite.ok")}
          </button>
        </div>`,
    );
  }
  const stopped = stoppedSheet(state, owner, Owner);
  if (stopped) {
    return sheet(
      stopped.title,
      html`<h3 class="break-words text-base font-semibold text-fg">${stopped.title}</h3>
        ${stopped.askedLine ? lines.asked : null}
        <p class="mt-3 text-sm text-fg">${stopped.body}</p>
        <div class="mt-4 flex justify-end">
          <button
            class="ui-btn-primary"
            data-dismiss
            autofocus
            @click=${() => actions.closeStoppedLink()}
          >
            ${t("invite.close")}
          </button>
        </div>`,
    );
  }
  if (state === "checkingLink") {
    const title = copy("join_request.checking_the_link");
    // Ends by itself within seconds, so there is no button and nothing dismisses it.
    return sheet(
      title,
      html`<h3 class="break-words text-base font-semibold text-fg">${title}</h3>`,
    );
  }
  if (state === "decidingToAsk" || state === "sendingRequest") {
    const sending = state === "sendingRequest";
    const title =
      invite.album === ""
        ? copy("invite.ask_to_join_unnamed")
        : copy("invite.ask_to_join", { album: invite.album });
    return sheet(
      title,
      html`<h3 class="break-words text-base font-semibold text-fg">${title}</h3>
        <p class="mt-3 text-sm text-fg">${t("invite.will_see_your_name_and", { owner: Owner })}</p>
        ${error ? html`<p class="mt-2 text-xs text-danger-fg" role="alert">${error}</p>` : null}
        <div class="mt-4 flex justify-end gap-2">
          <button
            class="ui-btn-ghost"
            data-dismiss
            autofocus
            ?disabled=${sending}
            @click=${() => actions.notNow()}
          >
            ${t("invite.not_now")}
          </button>
          <button class="ui-btn-primary" ?disabled=${sending} @click=${() => actions.askToJoin()}>
            ${sending ? copy("invite.asking") : copy("invite.ask_to_join_2")}
          </button>
        </div>`,
    );
  }
  if (state === "waitingForAdminToAccept" || state === "waitingForYouToUpdate") {
    const update = state === "waitingForYouToUpdate";
    const unnamed = invite.album === "";
    const title = update
      ? copy("invite.update_justus_to_join", {
          album: unnamed ? copy("albums.album_you_asked_to_join") : invite.album,
        })
      : copy("invite.waiting_for_to_let_you_in", { owner });
    const warn = !update && linkNamedOtherAlbum(invite.linkAlbum, invite.album);
    return sheet(
      title,
      html`<h3 class="break-words text-base font-semibold text-fg">${title}</h3>
        ${
          warn
            ? html`<div
                class="mt-3 rounded-xl bg-subtle px-4 py-2.5 text-sm text-fg ring-1 ring-trust-amber/40"
                role="status"
                data-link-named-other
              >
                <p>
                  ${copy("invite.link_named_other_album", {
                    linkAlbum: invite.linkAlbum ?? "",
                    album: invite.album,
                    owner,
                  })}
                </p>
                <p class="mt-1 text-muted">
                  ${copy("invite.link_names_help", {
                    close: copy("invite.close"),
                    cancel: copy("invite.cancel_request"),
                  })}
                </p>
              </div>`
            : null
        }
        <p id=${WAITING_LINE_ID} class="mt-3 text-sm text-fg">
          ${
            update
              ? t("invite.request_reaches_after_update", { owner })
              : t("invite.keep_justus_open_until", { owner })
          }
        </p>
        ${lines.checkCode}
        <div class="mt-4 flex justify-end gap-2">
          <button
            class=${warn ? "ui-btn-primary" : "ui-btn-ghost"}
            ?autofocus=${warn}
            @click=${() => actions.cancelRequest()}
          >
            ${t("invite.cancel_request")}
          </button>
          <button
            class=${warn ? "ui-btn-ghost" : "ui-btn-primary"}
            data-dismiss
            ?autofocus=${!warn}
            @click=${() => actions.closeWaiting()}
          >
            ${t("invite.close")}
          </button>
        </div>`,
      WAITING_LINE_ID,
    );
  }
  const title = copy("invite.didn_t_accept_your_request", { owner: Owner });
  return sheet(
    title,
    html`<h3 class="break-words text-base font-semibold text-fg">${title}</h3>
      <p class="mt-3 text-sm text-fg">${t("invite.nothing_was_shared_with_you")}</p>
      <p class="mt-2 text-sm text-muted">${t("invite.you_can_ask_again", { owner })}</p>
      ${error ? html`<p class="mt-2 text-xs text-danger-fg" role="alert">${error}</p>` : null}
      <div class="mt-4 flex justify-end gap-2">
        <button
          class="ui-btn-ghost"
          data-dismiss
          autofocus
          ?disabled=${state === "sendingRequestAgain"}
          @click=${() => actions.dismissDecline()}
        >
          ${t("invite.not_now")}
        </button>
        <button
          class="ui-btn-primary"
          ?disabled=${state === "sendingRequestAgain"}
          @click=${() => actions.askAgain()}
        >
          ${copy("invite.ask_again")}
        </button>
      </div>`,
  );
}
