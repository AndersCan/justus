import { MAX_HEADLINE_LINES } from "./stores.mjs";

// `rect` is the text's bounding box in image pixels.
export function headlineFits({ lines, rect, width, height, margin }) {
  if (lines > MAX_HEADLINE_LINES) {
    return {
      name: "headline fits",
      ok: false,
      message: `headline takes ${lines} lines, at most ${MAX_HEADLINE_LINES}`,
    };
  }
  const tolerance = 0.5;
  const inside =
    rect.left >= margin.side - tolerance &&
    rect.right <= width - margin.side + tolerance &&
    rect.top >= margin.top - tolerance &&
    rect.bottom <= height - margin.bottom + tolerance;
  if (!inside) {
    return { name: "headline fits", ok: false, message: "headline runs outside the margins" };
  }
  return { name: "headline fits", ok: true, message: "" };
}

export function captureNotUpscaled({ screenWidth, captureWidth }) {
  if (screenWidth > captureWidth) {
    return {
      name: "capture not upscaled",
      ok: false,
      message: `screen is ${Math.round(screenWidth)} px wide, capture only ${captureWidth} px`,
    };
  }
  return { name: "capture not upscaled", ok: true, message: "" };
}
