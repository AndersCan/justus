import { captureNotUpscaled, headlineFits } from "./checks.mjs";
import config from "./images.json";
import { HEADLINE_LINE_HEIGHT, STORES } from "./stores.mjs";

const BEZEL = 0.03;
const SCREEN = 1 - 2 * BEZEL;

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = url;
  });
}

function element(tag, className, parent) {
  const node = document.createElement(tag);
  node.className = className;
  parent.append(node);
  return node;
}

function place(node, box) {
  for (const [key, value] of Object.entries(box)) {
    node.style[key] = typeof value === "number" ? `${value}px` : value;
  }
}

function phoneHeight(pw, ratio) {
  return pw * SCREEN * ratio + 2 * BEZEL * pw;
}

function buildPhone({ parent, pw, ratio, landscape, capture, tileText }) {
  const phone = element("div", "phone", parent);
  const height = phoneHeight(pw, ratio);
  place(phone, { width: pw, height, borderRadius: 0.12 * pw });
  const screen = element("div", "screen", phone);
  place(screen, {
    left: BEZEL * pw,
    top: BEZEL * pw,
    width: SCREEN * pw,
    height: height - 2 * BEZEL * pw,
    borderRadius: 0.09 * pw,
  });
  if (capture) {
    const img = element("img", "", screen);
    img.src = capture.src;
    img.alt = "";
  } else {
    element("div", "tile", screen).textContent = tileText;
  }
  const camera = element("div", "camera", phone);
  const dot = 0.035 * pw;
  place(camera, {
    width: dot,
    height: dot,
    left: landscape ? (BEZEL + 0.025) * pw - dot / 2 : (pw - dot) / 2,
    top: landscape ? (height - dot) / 2 : (BEZEL + 0.025) * pw,
  });
  const thickness = 0.008 * pw;
  const buttons = landscape
    ? [{ left: 0.2 * pw, top: -thickness, width: 0.1 * pw, height: thickness }]
    : [
        { left: pw, top: 0.22 * pw, width: thickness, height: 0.12 * pw },
        { left: -thickness, top: 0.2 * pw, width: thickness, height: 0.08 * pw },
        { left: -thickness, top: 0.3 * pw, width: thickness, height: 0.08 * pw },
      ];
  for (const box of buttons) place(element("div", "button", phone), box);
  return { phone, screen, height };
}

function layoutPhone({ layout, store, headlineRect, ratio }) {
  const { width: W, height: H, margin } = store;
  const gap = 0.04 * H;
  const centred = (pw) => (W - pw) / 2;
  if (layout === "deviceBelow") {
    const pw = 0.84 * W;
    return { pw, box: { left: centred(pw), top: headlineRect.bottom + gap } };
  }
  if (layout === "deviceAbove") {
    const pw = 0.8 * W;
    const top = headlineRect.top - gap - phoneHeight(pw, ratio);
    return { pw, box: { left: centred(pw), top } };
  }
  if (layout === "headlineBelow") {
    const height = headlineRect.top - gap - margin.top;
    const pw = height / (SCREEN * ratio + 2 * BEZEL);
    return { pw, box: { left: centred(pw), top: margin.top } };
  }
  if (layout === "deviceAngled") {
    const pw = 0.78 * W;
    return {
      pw,
      box: { left: 0.16 * W, top: headlineRect.bottom + 0.06 * H, transform: "rotate(-12deg)" },
    };
  }
  const pw = 1.15 * W;
  return { pw, box: { left: 0.08 * W, top: headlineRect.bottom + 0.08 * H } };
}

const FLOW_IMAGES = 3;
const FLOW_COLOUR = "#FF8A5B";

function flowPath(W, H) {
  const point = (fx, fy) => `${+(fx * W).toFixed(2)} ${+(fy * H).toFixed(2)}`;
  return [
    `M ${point(0.7, 0.62)}`,
    `C ${point(0.85, 0.62)}, ${point(0.9, 0.56)}, ${point(1.0, 0.56)}`,
    `S ${point(1.4, 0.48)}, ${point(1.5, 0.5)}`,
    `S ${point(1.9, 0.44)}, ${point(2.0, 0.44)}`,
    `S ${point(2.2, 0.4)}, ${point(2.3, 0.4)}`,
  ].join(" ");
}

function buildFlowLayer({ strip, W, H }) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "flow-layer");
  svg.setAttribute("width", String(FLOW_IMAGES * W));
  svg.setAttribute("height", String(H));
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", flowPath(W, H));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", FLOW_COLOUR);
  path.setAttribute("stroke-width", String(0.012 * W));
  path.setAttribute("stroke-dasharray", `${0.03 * W} ${0.025 * W}`);
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  for (const [fx, fy] of [
    [0.7, 0.62],
    [2.3, 0.4],
  ]) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(fx * W));
    dot.setAttribute("cy", String(fy * H));
    dot.setAttribute("r", String(0.01 * W));
    dot.setAttribute("fill", FLOW_COLOUR);
    svg.append(dot);
  }
  strip.append(svg);
}

async function buildFlowCard({ strip, W, H }) {
  const card = element("img", "flow-card", strip);
  const width = 0.28 * W;
  const height = (width * 3) / 4;
  place(card, {
    width,
    height,
    left: W - width / 2,
    top: 0.56 * H - height / 2,
    borderWidth: 0.012 * W,
    borderRadius: 0.02 * W,
  });
  card.alt = "";
  await new Promise((resolve, reject) => {
    card.onload = resolve;
    card.onerror = () => reject(new Error(`flowPhoto ${config.flowPhoto} could not be loaded`));
    card.src = `/assets/sample-photos/${config.flowPhoto}`;
  });
}

function textRect(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect();
}

async function render() {
  const query = new URLSearchParams(location.search);
  const store = STORES[query.get("store")];
  const entry = config.images.find((image) => image.id === query.get("id"));
  const root = document.getElementById("image");
  if (!store || !entry) {
    root.textContent = `Unknown store or image: ${location.search}`;
    return { skip: "unknown store or image" };
  }
  const { width: W, height: H, margin } = store;
  place(root, { width: W, height: H });
  const flowIndex = config.images.indexOf(entry);
  let parent = root;
  let flowStrip;
  if (flowIndex < FLOW_IMAGES) {
    const strip = element("div", "flow-strip", root);
    place(strip, {
      width: FLOW_IMAGES * W,
      height: H,
      transform: `translateX(${-flowIndex * W}px)`,
    });
    parent = element("div", "flow-box", strip);
    place(parent, { left: flowIndex * W, width: W, height: H });
    await buildFlowCard({ strip, W, H });
    flowStrip = strip;
  }
  const landscape = entry.layout === "deviceLandscape";
  const capture = await loadImage(
    `/store-listing/captures/${store.captureDir}/${entry.capture}.png`,
  );
  const wrongShape = capture && landscape && capture.naturalWidth <= capture.naturalHeight;
  const label = store.name === "ios" ? "Needs iOS capture" : "Needs capture";
  const tileText = wrongShape ? "Needs a landscape capture" : `${label}: ${entry.capture}`;
  const usable = capture && !wrongShape;
  const ratio = usable ? capture.naturalHeight / capture.naturalWidth : landscape ? 0.5 : 2;

  await document.fonts.load(`700 ${store.headlineSize}px Inter`).catch(() => {
    throw new Error("Inter font file could not be loaded (store-listing/fonts)");
  });
  await document.fonts.ready;
  const headline = element("div", "headline", parent);
  headline.textContent = entry.headline;
  const bottomAnchored = entry.layout === "deviceAbove" || entry.layout === "headlineBelow";
  place(headline, {
    left: margin.side,
    width: W - 2 * margin.side,
    fontSize: store.headlineSize,
    ...(bottomAnchored ? { bottom: margin.bottom } : { top: margin.top }),
    ...(landscape ? { textAlign: "left" } : {}),
  });
  const headlineRect = headline.getBoundingClientRect();
  const { pw, box } = layoutPhone({ layout: entry.layout, store, headlineRect, ratio });
  const built = buildPhone({
    parent,
    pw,
    ratio,
    landscape,
    capture: usable ? { src: capture.src } : undefined,
    tileText,
  });
  place(built.phone, box);
  built.phone.style.zIndex = "0";
  if (flowStrip) buildFlowLayer({ strip: flowStrip, W, H });
  headline.style.zIndex = "1";

  const text = textRect(headline);
  const rect = {
    left: text.left,
    right: text.right,
    top: headlineRect.top,
    bottom: headlineRect.bottom,
  };
  const checks = [
    headlineFits({
      lines: Math.round(headlineRect.height / (store.headlineSize * HEADLINE_LINE_HEIGHT)),
      rect,
      width: W,
      height: H,
      margin,
    }),
  ];
  if (usable) {
    checks.push(
      captureNotUpscaled({ screenWidth: SCREEN * pw, captureWidth: capture.naturalWidth }),
    );
  }
  return { checks, skip: usable ? "" : tileText };
}

const result = await render().catch((error) => ({ error: String(error?.message ?? error) }));
document.body.dataset.result = JSON.stringify(result);
document.body.dataset.ready = "1";
