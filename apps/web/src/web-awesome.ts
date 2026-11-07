// The one place Web Awesome is registered. Rules:
// 1. Register components here only (one import line each); no view imports it.
// 2. Never use <wa-icon> without library="system": the default icon library
//    fetches SVGs from a Font Awesome CDN (blocked by the app's CSP, a leak
//    elsewhere). Use inline SVGs instead.
// Do not import webawesome.css or native.css: they restyle every native element.
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./web-awesome.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
