import { STORES } from "./stores.mjs";

const STRIP_HEIGHT = { play: 270, ios: 392 };

function element(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}

function imageUrl(store, id) {
  return `/store-listing/image.html?store=${store.name}&id=${id}`;
}

function closeZoom() {
  const zoom = document.getElementById("zoom");
  zoom.hidden = true;
  zoom.replaceChildren();
}

function openZoom(store, id) {
  const zoom = document.getElementById("zoom");
  const frame = element("iframe", "", zoom);
  frame.width = store.width;
  frame.height = store.height;
  frame.src = imageUrl(store, id);
  frame.title = id;
  zoom.hidden = false;
}

function strip(parent, store, images) {
  const row = element("div", "strip", parent);
  const scale = STRIP_HEIGHT[store.name] / store.height;
  for (const image of images) {
    const thumb = element("button", "thumb", row);
    thumb.type = "button";
    thumb.title = image.headline;
    thumb.style.width = `${store.width * scale}px`;
    thumb.style.height = `${STRIP_HEIGHT[store.name]}px`;
    const frame = element("iframe", "", thumb);
    frame.width = store.width;
    frame.height = store.height;
    frame.src = imageUrl(store, image.id);
    frame.style.transform = `scale(${scale})`;
    frame.tabIndex = -1;
    thumb.addEventListener("click", () => openZoom(store, image.id));
  }
}

function head(parent, icon, title, subtitle) {
  const box = element("div", "head", parent);
  const img = element("img", "", box);
  img.src = icon;
  img.alt = "";
  const words = element("div", "", box);
  element("h3", "", words, title);
  if (subtitle) element("p", "", words, subtitle);
}

function playColumn(parent, listing) {
  const { text, images } = listing;
  const column = element("section", "store play", parent);
  element("h2", "", column, "Google Play");
  head(column, text.play.icon, text.play.title);
  strip(column, STORES.play, images);
  element("p", "text", column, text.play.shortDescription);
  element("p", "text", column, text.play.description);
}

function iosColumn(parent, listing) {
  const { text, images } = listing;
  const column = element("section", "store ios", parent);
  element("h2", "", column, "App Store");
  head(column, text.ios.icon, text.ios.name, text.ios.subtitle);
  strip(column, STORES.ios, images);
  element("p", "text", column, text.ios.promotionalText);
  element("p", "text", column, text.ios.description);
}

async function show() {
  const banner = document.getElementById("banner");
  const stores = document.getElementById("stores");
  let listing;
  try {
    listing = await (await fetch("/store-listing/api/listing")).json();
  } catch (error) {
    listing = { ok: false, message: `Could not load the listing: ${error.message}` };
  }
  banner.hidden = listing.ok;
  stores.replaceChildren();
  if (!listing.ok) {
    banner.textContent = listing.message;
    return;
  }
  playColumn(stores, listing);
  iosColumn(stores, listing);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeZoom();
});
void show();
