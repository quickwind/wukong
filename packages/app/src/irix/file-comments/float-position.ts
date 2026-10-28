// Irix: where a box that floats by a selection goes so it stays inside the window.
const MARGIN = 8;

export type FloatingPlacement = { left: number } & ({ top: number } | { bottom: number });

export function floatingPlacement(input: {
  rectLeft: number;
  rectTop: number;
  rectBottom: number;
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
}): FloatingPlacement {
  const left = Math.max(
    MARGIN,
    Math.min(input.rectLeft, input.viewportWidth - input.width - MARGIN),
  );
  if (input.rectBottom + MARGIN + input.height <= input.viewportHeight) {
    return { left, top: input.rectBottom + MARGIN };
  }
  if (input.rectTop - MARGIN - input.height >= 0) {
    return { left, bottom: input.viewportHeight - input.rectTop + MARGIN };
  }
  return { left, top: Math.max(MARGIN, input.viewportHeight - input.height - MARGIN) };
}
