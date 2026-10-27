// Applies the saved theme before first paint. A file, not an inline script:
// the worklet's Content-Security-Policy (script-src 'self') blocks inline code.
try {
  var t = localStorage.getItem("justus:theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
