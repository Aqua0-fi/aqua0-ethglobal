/** ANSI colours for the live console output. Journal lines and non-terminal output stay plain. */

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39]
} as const;

type Style = keyof typeof CODES;

export type Painter = Record<Style | "yellowBold" | "magentaBold", (text: string) => string>;

/** Colour when the stream is a terminal, unless NO_COLOR is set; FORCE_COLOR turns it on anywhere. */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(stream.isTTY);
}

export function painter(enabled: boolean): Painter {
  const wrap =
    (...styles: Style[]) =>
    (text: string) =>
      enabled
        ? styles.reduce((out, style) => `\u001b[${CODES[style][0]}m${out}\u001b[${CODES[style][1]}m`, text)
        : text;
  return {
    bold: wrap("bold"),
    dim: wrap("dim"),
    red: wrap("red"),
    green: wrap("green"),
    yellow: wrap("yellow"),
    blue: wrap("blue"),
    magenta: wrap("magenta"),
    cyan: wrap("cyan"),
    yellowBold: wrap("yellow", "bold"),
    magentaBold: wrap("magenta", "bold")
  };
}
