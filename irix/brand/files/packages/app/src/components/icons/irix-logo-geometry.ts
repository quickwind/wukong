// Internal edition: the Irix comet-spin firework mark (4-fold swirling comet X blades
// around a central focal 'i' core) on a 700×700 canvas.
// The logo component and the splash mask draw from these paths. The favicon SVGs and the PNG
// icons next to them (assets/images, public) are separate files: when the mark changes here,
// redraw them too.

export const IRIX_LOGO_VIEWBOX = "0 0 700 700";
export const IRIX_LOGO_STROKE_WIDTH = 7;

export const IRIX_LOGO_STROKE_PATHS: readonly string[] = [
  "M 408 266 C 448 200, 504 156, 558 146 C 516 182, 472 225, 434 292 Q 402 298 408 266 Z",
  "M 434 408 C 500 448, 544 504, 554 558 C 518 516, 475 472, 408 434 Q 402 402 434 408 Z",
  "M 292 434 C 252 500, 196 544, 142 554 C 184 518, 228 475, 266 408 Q 298 402 292 434 Z",
  "M 266 292 C 200 252, 156 196, 146 142 C 182 184, 225 228, 292 266 Q 298 298 266 292 Z",
];

export const IRIX_LOGO_EYES: readonly { cx: number; cy: number; r: number }[] = [
  { cx: 350, cy: 350, r: 36 },
];

/** Standalone SVG markup, for CSS masks and data URIs. */
export function irixLogoSvgMarkup(input: { size: number; color: string }): string {
  const strokes = IRIX_LOGO_STROKE_PATHS.map(
    (d) => `<path d='${d}' fill='${input.color}' stroke='${input.color}'/>`,
  ).join("");
  const eyes = IRIX_LOGO_EYES.map(
    (e) => `<circle cx='${e.cx}' cy='${e.cy}' r='${e.r}' fill='${input.color}' stroke='none'/>`,
  ).join("");
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${input.size}' height='${input.size}' viewBox='${IRIX_LOGO_VIEWBOX}' fill='none' stroke='${input.color}' stroke-width='${IRIX_LOGO_STROKE_WIDTH}' stroke-linecap='round' stroke-linejoin='round'>${strokes}${eyes}</svg>`;
}
