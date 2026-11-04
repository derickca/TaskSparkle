// TaskSparkle's service worker exists for one reason: a registered,
// active worker is what lets a phone offer TaskSparkle as an app on
// the home screen. It is deliberately not a cache. It keeps no copy
// of the app, the boards or anything else — every request goes to
// the network, and a page that cannot reach the network hears about
// it from the app itself, in plain words, the way the boot already
// speaks when a load fails.
//
// A cached shell is the failure this app has already lived through:
// a browser holding old app files against a newer service stalled
// on the loading line (issue #4). Freshness here belongs to the
// cache headers on the app files and to the app's own build-stamp
// check on every open, which reloads a stale copy itself. This
// worker must never blunt either one, so it answers no request
// from storage and stores nothing.
//
// The fetch handler is a straight pass-through, named because
// installability checks look for one. Changing this file's bytes
// is all a future worker update ever needs: the browser notices
// the new copy on its own schedule and, since nothing is cached,
// the changeover has nothing to clear out.

self.addEventListener("fetch", function (event) {
  event.respondWith(fetch(event.request));
});
