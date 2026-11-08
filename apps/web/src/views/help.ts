import { html } from "lit-html";
import { pathFor } from "../machines/router-machine";

import { copy, t } from "../copy/copy";
export const HELP_QA: { q: string; a: string[] }[] = [
  {
    q: copy("help.what_is_justus"),
    a: [
      copy("help.justus_is_a_photo_sharing"),
      copy("help.what_is_peer_to_peer"),
      copy("help.that_means_no_company_including"),
    ],
  },
  {
    q: copy("help.why_don_t_i_see"),
    a: [copy("help.photos_only_travel_while_both"), copy("help.to_check_open_the_album")],
  },
  {
    q: copy("help.do_i_need_wifi"),
    a: [copy("help.no_but_it_helps_two"), copy("help.justus_suggests_this_after_about")],
  },
  {
    q: copy("help.what_if_i_lose_my"),
    a: [
      copy("help.your_photos_are_stored_on"),
      copy("help.on_a_new_phone_join"),
      copy("help.if_the_lost_phone_belonged"),
    ],
  },
  {
    q: copy("help.is_justus_a_backup"),
    a: [copy("help.no_justus_shares_photos_between")],
  },
  {
    q: copy("help.who_can_see_an_album"),
    a: [copy("help.only_the_people_in_the"), copy("help.removing_someone_moves_the_album")],
  },
  {
    q: copy("help.what_can_the_admin_see"),
    a: [copy("help.the_admin_is_the_person"), copy("help.they_can_t_see_anything")],
  },
  {
    q: copy("help.who_can_add_photos"),
    a: [copy("help.the_admin_chooses_when_they")],
  },
  {
    q: copy("help.how_do_i_get_rid"),
    a: [copy("help.archive_hides_it_on_this")],
  },
  {
    q: copy("help.who_can_delete_a_photo"),
    a: [copy("help.whoever_added_a_photo_can"), copy("help.deleting_a_photo_takes_it")],
  },
];

/** The Help destination: a short FAQ, starting with what peer to peer means. */
export function helpView() {
  return html`
    <div class="mx-auto max-w-2xl space-y-6">
      <a class="text-sm text-muted hover:text-fg" href=${pathFor("settings")}
        >${t("help.settings")}</a
      >
      <h1 class="text-2xl font-semibold tracking-tight text-fg">${t("help.help")}</h1>

      <section class="space-y-2" aria-label=${copy("help.frequently_asked_questions")}>
        ${HELP_QA.map(
          (item) => html`<details class="ui-card p-4">
            <summary class="ui-focus cursor-pointer select-none text-sm font-medium text-fg">
              ${item.q}
            </summary>
            <div class="mt-2 space-y-2 text-sm text-fg">
              ${item.a.map((p) => html`<p>${p}</p>`)}
            </div>
          </details>`,
        )}
      </section>
    </div>
  `;
}
