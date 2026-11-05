import { html, svg } from "lit-html";

/**
 * The "just·us" wordmark (Inter SemiBold outlines; source in assets/brand/).
 * Letters take `currentColor`, so `text-fg` follows the light/dark theme,
 * including the in-app override. The coral dot is the one brand accent per
 * screen. `animated` plays the two dots meeting, unless the user asked for
 * reduced motion (SMIL ignores that preference, so CSS swaps the dots).
 */
export function wordmark(cls: string, animated = false) {
  return html`<svg
    class="${cls}"
    viewBox="14 40 398 124"
    role="img"
    aria-label="Justus"
    fill="currentColor"
  >
    <g>
      <path
        transform="translate(20.00,135) scale(0.05859,-0.05859)"
        d="M137 1118V-62C137 -156 97 -205 -4 -205H-42V-418H11C255 -418 398 -307 398 -65V1118ZM268 1276C351 1276 420 1340 420 1419C420 1498 351 1561 268 1561C185 1561 117 1498 117 1419C117 1340 185 1276 268 1276Z"
      />
      <path
        transform="translate(51.41,135) scale(0.05859,-0.05859)"
        d="M521 -14C683 -14 800 64 867 224L869 0H1116V1118H855V463C855 301 755 207 617 207C481 207 398 297 398 447V1118H138V407C138 138 291 -14 521 -14Z"
      />
      <path
        transform="translate(124.88,135) scale(0.05859,-0.05859)"
        d="M561 -23C843 -23 1041 123 1041 335C1041 492 940 592 728 637L538 677C424 702 379 743 379 808C379 884 463 938 573 938C693 938 757 876 783 798L1015 844C970 1017 823 1132 570 1132C302 1132 119 999 119 792C119 628 222 525 433 479L624 438C726 416 775 375 775 310C775 234 694 176 566 176C439 176 361 229 331 340L88 294C127 91 304 -23 561 -23Z"
      />
      <path
        transform="translate(190.80,135) scale(0.05859,-0.05859)"
        d="M655 1118H439V1384H179V1118H20V914H179V293C179 95 298 -15 512 -15C567 -15 629 -8 686 9L645 210C620 204 574 197 550 197C471 197 439 234 439 315V914H655Z"
      />
      <path
        transform="translate(273.96,135) scale(0.05859,-0.05859)"
        d="M521 -14C683 -14 800 64 867 224L869 0H1116V1118H855V463C855 301 755 207 617 207C481 207 398 297 398 447V1118H138V407C138 138 291 -14 521 -14Z"
      />
      <path
        transform="translate(347.44,135) scale(0.05859,-0.05859)"
        d="M561 -23C843 -23 1041 123 1041 335C1041 492 940 592 728 637L538 677C424 702 379 743 379 808C379 884 463 938 573 938C693 938 757 876 783 798L1015 844C970 1017 823 1132 570 1132C302 1132 119 999 119 792C119 628 222 525 433 479L624 438C726 416 775 375 775 310C775 234 694 176 566 176C439 176 361 229 331 340L88 294C127 91 304 -23 561 -23Z"
      />
    </g>
    ${
      animated
        ? svg`<g class="motion-reduce:hidden">
          <circle cx="253.56" cy="102.25" r="7.8" class="fill-brand">
            <animate attributeName="cx" values="243.36;253.56;253.56;243.36" keyTimes="0;0.4;0.7;1" dur="2.4s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1"/>
          </circle>
          <circle cx="253.56" cy="102.25" r="7.8" class="fill-brand">
            <animate attributeName="cx" values="263.76;253.56;253.56;263.76" keyTimes="0;0.4;0.7;1" dur="2.4s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1"/>
          </circle>
        </g>`
        : null
    }
    <circle
      cx="253.56"
      cy="102.25"
      r="8.58"
      class="fill-brand ${animated ? "motion-safe:hidden" : ""}"
    />
  </svg>`;
}

/**
 * The wordmark set inline in running text. Sized so the glyphs match the
 * surrounding x-height and the baseline lines up with the text (the viewBox
 * keeps ~0.22em of descender room below the baseline). No coral dot animation:
 * the dot is the one brand accent per screen, so this one stays static.
 */
export function justus() {
  return html`<span class="inline-block align-baseline" style="height:0.95em;vertical-align:-0.22em"
    >${wordmark("h-full w-auto")}</span
  >`;
}
