// Set the theme before the page paints so nobody sees a flash of the
// wrong colours. The theme choice lives in this device's settings in
// local storage; a small mirror beside it (a copy of the theme, and
// nothing else) covers a device that has not chosen yet. The boards
// themselves come from the API and are never stored here.
//
// This lives in its own file rather than inline in index.html so
// the page's Content-Security-Policy can stay script-src 'self'
// with no inline exception (issue #70). It is loaded as a plain
// script in the head, so it still runs before the body paints.
(function () {
  var mode = "system";
  var look = "standard";
  try {
    var devRaw = localStorage.getItem("tasksparkle-device");
    if (devRaw) {
      var dev = JSON.parse(devRaw);
      if (dev && dev.theme) mode = dev.theme;
      if (dev && dev.look) look = dev.look;
    }
    if (mode === "system") {
      var raw = localStorage.getItem("tasksparkle-mirror");
      if (raw) {
        var mirror = JSON.parse(raw);
        if (mirror && mirror.theme) mode = mirror.theme;
      }
    }
  } catch (e) { /* A broken store falls back to System. */ }
  if (mode !== "system" && mode !== "light" && mode !== "dark") mode = "system";
  var dark = mode === "dark" ||
    (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme-mode", mode);
  var looks = ["standard", "comic", "console", "pretty", "artistic", "sunset", "forest", "midnight"];
  if (looks.indexOf(look) === -1) look = "standard";
  document.documentElement.setAttribute("data-look", look);
})();
