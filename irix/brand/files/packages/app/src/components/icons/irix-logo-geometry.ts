// Internal edition: the Irix fluid ribbon mark (continuous "i-x" loop and focal eye)
// on a 700×700 canvas.
// The logo component and splash mask draw from these paths so the mark is defined once.

export const IRIX_LOGO_VIEWBOX = "0 0 700 700";
export const IRIX_LOGO_STROKE_WIDTH = 44;

export const IRIX_LOGO_STROKE_PATHS: readonly string[] = [
  "M 220 220 C 220 330, 250 400, 320 450 C 430 530, 560 470, 560 350 C 560 240, 460 180, 360 260 C 280 325, 210 410, 170 510 C 150 560, 230 580, 290 540 C 390 480, 470 350, 530 230",
];

export const IRIX_LOGO_EYES: readonly { cx: number; cy: number; r: number }[] = [
  { cx: 220, cy: 150, r: 24 },
];

/** Standalone SVG markup, for CSS masks and data URIs. */
export function irixLogoSvgMarkup(input: { size: number; color: string }): string {
  const strokes = IRIX_LOGO_STROKE_PATHS.map((d) => `<path d='${d}'/>`).join("");
  const eyes = IRIX_LOGO_EYES.map(
    (e) => `<circle cx='${e.cx}' cy='${e.cy}' r='${e.r}' fill='${input.color}' stroke='none'/>`,
  ).join("");
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${input.size}' height='${input.size}' viewBox='${IRIX_LOGO_VIEWBOX}' fill='none' stroke='${input.color}' stroke-width='${IRIX_LOGO_STROKE_WIDTH}' stroke-linecap='round' stroke-linejoin='round'>${strokes}${eyes}</svg>`;
}
