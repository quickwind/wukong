// Internal edition: the Wukong line-art head (spiky flame hair, double-curl
// golden circlet, ears, peach-shaped face) on a 512×512 canvas.
// The logo component and splash mask draw from these paths so the mark is defined once.

export const WUKONG_LOGO_VIEWBOX = "0 0 512 512";
export const WUKONG_LOGO_STROKE_WIDTH = 32;

export const WUKONG_LOGO_STROKE_PATHS: readonly string[] = [
  // Left ear
  "M 62 295 A 46 46 0 1 0 154 295 A 46 46 0 1 0 62 295",
  // Right ear
  "M 358 295 A 46 46 0 1 0 450 295 A 46 46 0 1 0 358 295",
  // 5-spike flame hair
  "M 140 225 L 168 150 L 198 190 L 227 120 L 256 180 L 285 120 L 314 190 L 344 150 L 372 225",
  // Head & chin silhouette
  "M 140 225 C 130 320, 160 415, 215 442 C 235 452, 277 452, 297 442 C 352 415, 382 320, 372 225",
  // Headband left curl
  "M 125 236 Q 185 222, 222 220 C 234 192, 251 182, 254 202 C 255 214, 245 222, 236 218",
  // Headband right curl
  "M 387 236 Q 327 222, 290 220 C 278 192, 261 182, 258 202 C 257 214, 267 222, 276 218",
  // Peach face mask contour
  "M 256 250 C 236 220, 182 226, 178 285 C 174 340, 224 395, 256 410 C 288 395, 338 340, 334 285 C 330 226, 276 220, 256 250 Z",
];

export const WUKONG_LOGO_EYES: readonly { cx: number; cy: number; r: number }[] = [];

/** Standalone SVG markup, for CSS masks and data URIs. */
export function wukongLogoSvgMarkup(input: { size: number; color: string }): string {
  const strokes = WUKONG_LOGO_STROKE_PATHS.map((d) => `<path d='${d}'/>`).join("");
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${input.size}' height='${input.size}' viewBox='${WUKONG_LOGO_VIEWBOX}' fill='none' stroke='${input.color}' stroke-width='${WUKONG_LOGO_STROKE_WIDTH}' stroke-linecap='round' stroke-linejoin='round'>${strokes}</svg>`;
}
