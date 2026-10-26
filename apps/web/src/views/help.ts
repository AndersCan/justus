import { html } from "lit-html";
import { INTRO_CARDS } from "./welcome";

const QA: { q: string; a: string[] }[] = [
  {
    q: "Why can't I see Maya's new photos?",
    a: [
      "Photos move directly between phones, and only while two members both have Justus open and can reach each other.",
      "If Maya's phone is off or Justus is closed, her new photos arrive the next time you are both connected. The People list shows who is connected now and when the others were last seen.",
    ],
  },
  {
    q: "Why is it stuck on “waiting”?",
    a: [
      "“Waiting for the Admin” means the Admin hasn't approved you yet. Approving needs the Admin's phone to be open and reachable, so ask them to open Justus.",
      "If it says it can't reach someone, see the WiFi question below.",
    ],
  },
  {
    q: "Do I need WiFi?",
    a: [
      "Not strictly, but it helps. Mobile carriers often change network addresses, so two phones that are both on mobile data may fail to find each other.",
      "If one of you switches to WiFi it usually works. Justus waits about 30 seconds before suggesting this.",
    ],
  },
  {
    q: "What if I lose my phone?",
    a: [
      "Photos live on your devices, not in the cloud. Photos that also exist on another member's device are still there. Photos only on the lost phone are gone.",
      "On a new phone, ask to join the album again with an invite.",
      "If the Admin's phone is lost, no one new can be approved. Existing members keep their photos and keep syncing. Handing the Admin role to someone else is not possible yet.",
    ],
  },
  {
    q: "What can the Admin see and do?",
    a: [
      "The Admin started the album. They approve each person who joins and can remove members.",
      "Everyone in an album sees everything in it, past and future, and can see who is connected. The Admin sees nothing the others can't, and nobody outside the album can see anything. There is no server in between.",
    ],
  },
];

/** The Help destination: Q&A plus the intro cards again. */
export function helpView() {
  return html`
    <div class="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-fg">Help</h1>
        <p class="mt-1 text-sm text-muted">
          Servers involved: 0. Photos go straight between phones.
        </p>
      </div>

      <section class="space-y-2" aria-label="Questions and answers">
        ${QA.map(
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

      <section class="ui-card p-5">
        <h2 class="ui-label mb-3">How Justus works</h2>
        <ol class="space-y-3">
          ${INTRO_CARDS.map(
            (c) => html`<li class="flex gap-3">
              <span class="text-2xl" aria-hidden="true">${c.icon}</span>
              <div>
                <p class="text-sm font-medium text-fg">${c.title}</p>
                <p class="text-sm text-muted">${c.body}</p>
              </div>
            </li>`,
          )}
        </ol>
      </section>
    </div>
  `;
}
