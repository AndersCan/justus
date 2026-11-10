// Store image sizes and layout margins, in image pixels.
export const LAYOUTS = [
  "deviceAbove",
  "deviceLandscape",
  "deviceBelow",
  "headlineBelow",
  "deviceAngled",
];

export const STORES = {
  play: {
    name: "play",
    captureDir: "android",
    width: 1080,
    height: 1920,
    margin: { side: 90, top: 120, bottom: 120 },
    headlineSize: 120,
  },
  ios: {
    name: "ios",
    captureDir: "ios",
    width: 1320,
    height: 2868,
    margin: { side: 110, top: 150, bottom: 150 },
    headlineSize: 150,
  },
};

export const HEADLINE_LINE_HEIGHT = 1.1;
export const MAX_HEADLINE_LINES = 2;
