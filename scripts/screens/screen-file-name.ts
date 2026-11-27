export type Theme = "light" | "dark";

export type ThemeChoice = Theme | "both";

interface ScreenFileNameOptions {
  position: number;
  theme: Theme;
}

/**
 * The PNG name for a screen: a three-digit walk position, the screen, then its theme, so a folder
 * listing reads in walk order and each file says how it was drawn.
 */
export function screenFileName(screen: string, options: ScreenFileNameOptions): string {
  const position = String(options.position).padStart(3, "0");
  return `${position}-${screen}-${options.theme}.png`;
}

/** Whether a file is one `screenFileName` writes, so a new run can clear only those. */
export function isScreenFileName(fileName: string): boolean {
  return /^\d{3}-[a-z0-9-]+-(light|dark)\.png$/.test(fileName);
}

/** The themes one run shoots, in the order each screen gets them. */
export function themesFor(themeChoice: ThemeChoice): Theme[] {
  switch (themeChoice) {
    case "light":
      return ["light"];
    case "dark":
      return ["dark"];
    case "both":
      return ["light", "dark"];
    default:
      return isNever(themeChoice);
  }
}

function isNever(value: never): never {
  throw new Error(`unexpected theme choice ${String(value)}`);
}
