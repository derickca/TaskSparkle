// The feedback page's script (issue #14; the target became a
// deployment setting in issue #22). The page first asks the
// deployment whether it takes feedback at all (GET /api/site):
// a copy with no feedback target set shows the not-found block
// instead of the form, and this copy's server answers the
// page's own address with a real not-found besides, where the
// server is the one serving pages. A copy with a target shows
// the form, and the form posts to the app's own API — the
// server passes the note to the deployment's target and
// relays its answer, so no outside address stands in this
// file or in the page's security policy. The defences are the
// target service's own pattern — a honeypot field, a
// three-second minimum open time before Send wakes, and
// per-browser rate caps — and the service re-checks every one
// of them server-side.
(function () {
  var onBlock = document.getElementById("feedback-on");
  var offBlock = document.getElementById("feedback-off");
  var form = document.getElementById("feedback-form");
  if (!onBlock || !offBlock || !form) return;

  function showOff() {
    document.title = "Not found — TaskSparkle";
    onBlock.hidden = true;
    offBlock.hidden = false;
  }

  fetch("/api/site")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.feedback) {
        offBlock.hidden = true;
        onBlock.hidden = false;
        startForm();
      } else {
        showOff();
      }
    })
    .catch(showOff);

  function startForm() {
    var send = document.getElementById("fb-send");
    var status = document.getElementById("fb-status");
    var note = document.getElementById("fb-note");
    var count = document.getElementById("fb-count");
    var openedAt = Date.now();

    function showCount() {
      count.textContent = note.value.length.toLocaleString("en-US") + " of 10,000 characters";
    }
    note.addEventListener("input", showCount);
    showCount();

    // Send stays disabled for the first three seconds.
    setTimeout(function () { send.disabled = false; }, 3000);

    // Rate caps: three per ten minutes, ten per day, kept in
    // this browser's own store.
    function sentLog() {
      try { return JSON.parse(localStorage.getItem("ts-feedback-log") || "[]"); }
      catch (e) { return []; }
    }
    function rateBlocked() {
      var now = Date.now();
      var inTen = 0, inDay = 0;
      sentLog().forEach(function (t) {
        if (now - t < 10 * 60 * 1000) inTen++;
        if (now - t < 24 * 60 * 60 * 1000) inDay++;
      });
      return inTen >= 3 || inDay >= 10;
    }
    function recordSent() {
      var log = sentLog();
      log.push(Date.now());
      try { localStorage.setItem("ts-feedback-log", JSON.stringify(log.slice(-20))); } catch (e) { /* storage can refuse */ }
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var message = note.value.trim();
      if (!message) {
        status.textContent = "Write your note first, then send.";
        return;
      }
      if (rateBlocked()) {
        status.textContent = "You've sent a few messages already — please wait a bit before sending more.";
        return;
      }
      var kind = form.querySelector('input[name="kind"]:checked');
      var fields = { message: message.slice(0, 10000), page: "/feedback" };
      var pagelink = form.querySelector('[name="fb_pagelink"]').value.trim();
      var name = form.querySelector('[name="fb_name"]').value.trim();
      if (pagelink) fields.pagelink = pagelink.slice(0, 300);
      if (name) fields.name = name.slice(0, 120);
      send.disabled = true;
      status.textContent = "Sending…";
      fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "tasksparkle",
          type: kind ? kind.value : "other",
          fields: fields,
          website: form.querySelector('[name="website"]').value,
          openedAt: openedAt,
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) {
            recordSent();
            status.textContent = "Thanks — your feedback was sent.";
            note.value = "";
            showCount();
            form.querySelector('[name="fb_pagelink"]').value = "";
          } else {
            status.textContent = "Sorry, that didn't go through. Please try again.";
          }
          send.disabled = false;
        })
        .catch(function () {
          status.textContent = "Sorry, that didn't go through. Please try again.";
          send.disabled = false;
        });
    });
  }
})();
