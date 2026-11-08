// The public pages' Feedback entries (issue #22): they stand
// in the markup hidden, because whether they stand at all is
// the deployment's fact, not the page's — a copy whose
// operator set a feedback target shows them, and a copy with
// no target set never does. This script asks the deployment
// (GET /api/site) and settles them: shown when a target
// stands; removed when none does, with the pages' prose links
// to the Feedback page unwrapped to their plain words. A copy
// whose API cannot be reached settles as unset — the page
// those entries name is served by the same deployment, so
// nothing they point at would answer either.
(function () {
  function settle(on) {
    var entries = document.querySelectorAll("[data-feedback-link]");
    for (var i = 0; i < entries.length; i++) {
      if (on) entries[i].removeAttribute("hidden");
      else entries[i].remove();
    }
    if (!on) {
      var prose = document.querySelectorAll("[data-feedback-prose]");
      for (var j = 0; j < prose.length; j++) {
        prose[j].replaceWith(document.createTextNode(prose[j].textContent));
      }
    }
  }
  fetch("/api/site")
    .then(function (r) { return r.json(); })
    .then(function (d) { settle(!!(d && d.feedback)); })
    .catch(function () { settle(false); });
})();
