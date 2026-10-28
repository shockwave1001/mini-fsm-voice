/*
 * Mini FSM voice page (inbox 193). One static page, no build step, no secrets in it. Talk on the job card opens it in its
 * own Safari tab with a one time ticket in the URL fragment: #t=<ticket>&e=<event id>&a=<web app address>.
 *
 * The page trades the ticket with the web app for a session, the card's fields with their values and a short lived
 * ElevenLabs token (Deepgram when Setup says so). It then runs the same conversation as the card's Talk: one question at
 * a time, barge-in, mute, and a read-back with a spoken or tapped yes before any money or decision. Each confirmed change
 * is saved by the server as a field only save, so the card shows it on its next refresh.
 *
 * Every request is a POST with a plain text body and no headers, so the browser sends no CORS preflight.
 * Transcripts are not stored here and nothing is logged.
 */
var VoicePage = (function () {
  "use strict";

  // ---- Pure helpers (also run by tools/run-tests.js) ----
  var UNDO_MS = 30000, IDLE_MS = 180000, HOLD_MS = 600;
  var FIRST_PASS = ["type", "brand", "model", "serial", "issue"], FIRST_DIAG = ["diagnosis", "action"];

  function parseFragment(hash, local) {
    var h = String(hash || "").replace(/^#/, ""), out = {};
    h.split("&").forEach(function (kv) {
      var i = kv.indexOf("="); if (i < 1) return;
      try { out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* bad escape */ }
    });
    if (!/^[0-9a-f]{64}$/.test(out.t || "") || !out.e || !(/^https:\/\/script\.google\.com\/.+\/exec$/.test(out.a || "") || (local && /^http:\/\/127\.0\.0\.1:\d+\//.test(out.a || "")))) return null;
    return { ticket: out.t, eventId: out.e, app: out.a };
  }

  // Phone numbers, emails and long digit runs (cards) never leave the page.
  function redact(s) {
    return String(s || "").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]").replace(/\b(?:\d[ -]?){13,19}\b/g, "[number]").replace(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, "[phone]").replace(/\b\d{10}\b/g, "[phone]");
  }
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim().replace(/ please$/, ""); }
  function words(s) { return norm(s).split(" ").filter(Boolean); }
  function money(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : Math.round(n * 100) / 100; }
  function fmt(n) { return "$" + (Math.round(n * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  var CMDS = [
    ["yes", /^(yes|yeah|yep|yup|yes it is|correct|confirm|confirmed|that s right|that is right|right|do it|save it|affirmative)$/],
    ["no", /^(no|nope|nah|cancel|wrong|that s wrong|don t|do not|negative)$/],
    ["next", /^(next|skip|skip it|next one|next question)$/],
    ["undo", /^(undo|undo that|undo it|take it back)$/],
    ["mute", /^(mute|be quiet|quiet|silence)$/],
    ["unmute", /^(unmute|speak|talk to me)$/],
    ["stop", /^(done|i am done|i m done|that is all|that s all|that s it|finish|finish up|stop listening|stop|goodbye|all done)$/]
  ];
  function command(text) { var n = norm(text).replace(/'/g, " ").replace(/\s+/g, " ").trim(); for (var i = 0; i < CMDS.length; i++) if (CMDS[i][1].test(n)) return CMDS[i][0]; return ""; }

  function byKey(fields) { var m = {}; fields.forEach(function (f) { m[f.key] = f; }); return m; }
  function shown(f, v) { return f.kind === "money" ? fmt(money(v) || 0) : f.kind === "bool" ? (/^(true|yes|1|on|checked|done)/i.test(v) ? "yes" : "no") : String(v); }

  // The sentence the technician says yes to.
  function readBack(f, value) { return "Set " + f.label.charAt(0).toLowerCase() + f.label.slice(1) + " to " + shown(f, value) + ", yes?"; }

  // Which changes are saved at once and which wait for a yes: money, decisions and anything Claude was unsure of wait.
  function plan(changes, fields) {
    var map = byKey(fields), now = [], wait = [], bad = [];
    (changes || []).forEach(function (c) {
      var f = map[c.field];
      if (!f) { bad.push("That field is not on the card"); return; }
      if (String(f.value || "") === String(c.value || "") && f.kind !== "note") return;
      if (f.gated || c.sure === false) wait.push({ field: c.field, value: c.value, say: readBack(f, c.value) });
      else now.push({ field: c.field, value: c.value });
    });
    return { now: now, wait: wait, bad: bad };
  }

  // The next field to ask about: Claude's pick when it is still empty, else the first empty basics of each appliance.
  function nextField(fields, skipped, ask) {
    var map = byKey(fields), a = ask && map[ask];
    if (a && !a.value && !skipped[ask]) return a;
    var seen = {}, apps = [];
    fields.forEach(function (f) { var m = /^a(\d+)\./.exec(f.key); if (m && !seen[m[1]]) { seen[m[1]] = 1; apps.push(m[1]); } });
    for (var i = 0; i < apps.length; i++) {
      var keys = FIRST_PASS.map(function (p) { return "a" + apps[i] + "." + p; }).concat(FIRST_DIAG.map(function (p) { return "a" + apps[i] + ".d1." + p; }));
      for (var k = 0; k < keys.length; k++) { var f = map[keys[k]]; if (f && !f.value && !skipped[f.key]) return f; }
    }
    return null;
  }
  function question(f) {
    if (!f) return "Anything else? Say done when you are finished.";
    return f.label.replace(/ \(.*\)$/, "") + (/\(/.test(f.label) ? " for " + /\((.*)\)$/.exec(f.label)[1] : "") + "?";
  }

  // ---- The server, over a plain text POST ----
  function createApi(app, fetchFn) {
    var f = fetchFn || (typeof fetch !== "undefined" ? fetch.bind(window) : null);
    return function (body) {
      // No headers and a string body: a text/plain request, which the browser sends without a preflight.
      return f(app, { method: "POST", body: JSON.stringify(body), redirect: "follow", credentials: "omit", cache: "no-store" })
        .then(function (r) { return r.text(); })
        .then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, message: "The server sent something unreadable." }; } });
    };
  }

  // ---- The conversation ----
  // ui: { note(text, bad), question(text), transcript(text), fields(list), pending(item|null), chips(list), status(text), talk(state) }
  // io: the VoiceIO module (create, unlock); speak: (text) => Promise
  function createController(deps) {
    var api = deps.api, ui = deps.ui, ioMod = deps.io, session = "", fields = [], lists = {}, skipped = {}, pending = [], undo = [];
    var S = { conv: false, starting: false, busy: false, mute: false, partial: "", last: "", lastSpoken: "", spoken: "", focus: "", ask: "", io: null, provider: "", title: "" };

    function setFields(f) { fields = f || fields; ui.fields(fields); }
    function note(t, bad) { ui.note(t || "", !!bad); }
    function curField() { return S.focus ? byKey(fields)[S.focus] : null; }
    function step() {
      var f = nextField(fields, skipped, S.ask); S.focus = f ? f.key : ""; S.ask = "";
      ui.question(question(f)); ui.pending(pending[0] || null); turn();
    }
    // What the page says next: the read-back when something waits for a yes, else the note and the question.
    function speakText() {
      if (pending[0]) return pending[0].say;
      return [S.note, question(curField())].filter(Boolean).join(" ").slice(0, 400);
    }
    function turn() { if (!S.conv) return; clearTimeout(S.tt); S.tt = setTimeout(speakNow, 120); }
    function speakNow() {
      if (!S.conv || !S.io || S.busy) return;
      var text = speakText(); if (!text || text === S.lastSpoken) return;
      S.lastSpoken = text; S.spoken = text; if (S.mute) return;
      var p = S.io.speak(text, function (cb) { api({ action: "voiceMouth", session: session }).then(function (r) { cb(r && r.ok ? r.token : ""); }, function () { cb(""); }); });
      ui.talk(S); Promise.resolve(p).then(function () { ui.talk(S); });
    }
    function idle() { clearTimeout(S.idleT); S.idleT = setTimeout(function () { if (S.conv) { stopTalk(); S.note = ""; note("Stopped after a quiet while. Tap Talk to go on."); } }, deps.idleMs || IDLE_MS); }

    function save(list, yes, isUndo) {
      S.busy = true; ui.talk(S);
      var prev = {}; list.forEach(function (c) { var f = byKey(fields)[c.field]; if (f) prev[c.field] = f.value; });
      return api({ action: "voiceSave", session: session, changes: list.map(function (c) { return { field: c.field, value: c.value, yes: !!yes || undefined }; }) }).then(function (r) {
        S.busy = false;
        if (!r || !r.ok) { S.note = (r && r.message) || "Could not save that."; note(S.note, true); ui.talk(S); step(); return r; }
        setFields(r.fields);
        var bad = (r.failed || []);
        S.note = bad.length ? bad[0] : (r.otherChanged && r.otherChanged.length ? "Saved. The card was also changed elsewhere: " + r.otherChanged.join(", ") + "." : "");
        note(S.note, !!bad.length);
        var item = { labels: r.applied || [], undo: list.filter(function (c) { return prev[c.field] !== undefined && byKey(fields)[c.field] && byKey(fields)[c.field].kind !== "note" && byKey(fields)[c.field].kind !== "money" && prev[c.field] !== ""; }).map(function (c) { return { field: c.field, value: prev[c.field] }; }) };
        if (item.labels.length && !isUndo) {
          undo.unshift(item); item.timer = setTimeout(function () { undo = undo.filter(function (x) { return x !== item; }); ui.chips(undo); }, deps.undoMs || UNDO_MS);
          undo = undo.slice(0, 3); ui.chips(undo);
        }
        ui.talk(S); step(); return r;
      }, function () { S.busy = false; S.note = "No signal. Nothing was saved."; note(S.note, true); ui.talk(S); step(); return { ok: false }; });
    }

    function accept() {
      var c = pending.shift(); if (!c) { note("Nothing waits for a yes."); return Promise.resolve(); }
      return save([c], true);
    }
    function reject() { var c = pending.shift(); if (!c) { note("Nothing waits for a no."); return; } S.note = "Not saved."; note(S.note); step(); }
    function doUndo() {
      var it = undo[0];
      if (!it || !it.undo.length) { S.note = "Nothing to undo here. Fix it on the card."; note(S.note, true); step(); return Promise.resolve(); }
      clearTimeout(it.timer); undo = undo.filter(function (x) { return x !== it; }); ui.chips(undo);
      return save(it.undo, true, true).then(function () { S.note = it.labels.join(", ") + " put back."; note(S.note); });
    }

    function heard(text) {
      var t = redact(String(text || "").replace(/\s+/g, " ").trim()); S.last = t; ui.transcript(t); idle();
      if (!t) return Promise.resolve();
      var c = command(t);
      if (c === "yes") return accept();
      if (c === "no") { reject(); return Promise.resolve(); }
      if (c === "next") { if (pending.length) { note("Say yes or no first.", true); return Promise.resolve(); } if (S.focus) skipped[S.focus] = true; S.note = ""; step(); return Promise.resolve(); }
      if (c === "undo") return doUndo();
      if (c === "mute" || c === "unmute") { setMute(c === "mute"); return Promise.resolve(); }
      if (c === "stop") { stopTalk(); note("Voice stopped. Finish the visit on the card."); return Promise.resolve(); }
      if (pending.length) { S.note = "Say yes or no first."; note(S.note, true); turn(); return Promise.resolve(); }
      S.busy = true; ui.talk(S); note("Listening to what you said…");
      return api({ action: "voiceTurn", session: session, transcript: t, focus: S.focus }).then(function (r) {
        S.busy = false;
        if (!r || !r.ok) { S.note = (r && r.message) || "Could not understand that. Try again."; note(S.note, true); ui.talk(S); step(); return; }
        var p = plan(r.changes, fields); S.ask = r.ask || "";
        p.wait.forEach(function (w) { if (!pending.some(function (x) { return x.field === w.field; })) pending.push(w); });
        if (!p.now.length) {
          S.note = p.bad[0] || (!p.wait.length ? (r.say || "Nothing changed.") : ""); note(S.note, !!p.bad.length); ui.talk(S); step(); return;
        }
        return save(p.now, false);
      }, function () { S.busy = false; S.note = "No signal. Say it again when you are back."; note(S.note, true); ui.talk(S); step(); });
    }

    function partial(t) {
      S.partial = t; ui.transcript(t); idle();
      if (S.io && S.io.speaking()) { var heardW = words(t), said = {}; words(S.spoken).forEach(function (w) { said[w] = 1; }); if (heardW.length >= 2 && heardW.some(function (w) { return !said[w]; })) S.io.hush(); }
    }
    function final(t) {
      S.partial = "";
      if (S.io && S.io.speaking()) { var hw = words(t), said = {}; words(S.spoken).forEach(function (w) { said[w] = 1; }); if (hw.length && hw.every(function (w) { return said[w]; })) return; S.io.hush(); }
      S.lastSpoken = ""; heard(t);
    }
    function stopTalk() {
      clearTimeout(S.tt); clearTimeout(S.idleT);
      var io = S.io; S.io = null; S.conv = false; S.starting = false; S.partial = ""; if (io) io.stop(); ui.talk(S); ui.transcript(S.last);
    }
    function setMute(m) { S.mute = m; if (deps.saveMute) deps.saveMute(m); if (m && S.io) S.io.hush(); else S.lastSpoken = ""; ui.talk(S); if (!m) turn(); else note("Muted. The page still shows everything."); }

    function startTalk(voice) {
      if (S.conv || S.starting) return Promise.resolve();
      S.starting = true; ui.talk(S); note("Starting the microphone…");
      var go = function (v) {
        if (!v || !v.ok) { S.starting = false; ui.talk(S); note((v && v.message) || "Voice could not start.", true); return Promise.resolve(); }
        S.provider = v.provider;
        var io = ioMod.create(v, { onPartial: partial, onFinal: final, onError: function (m) { note(m, true); },
          onStep: function (n) { note(n === "mic" ? "Asking for the microphone…" : "Microphone on. Connecting to the speech service…"); },
          onClose: function () { var t = S.partial; if (S.io !== io) return; S.io = null; S.conv = false; S.partial = ""; ui.talk(S); note("The voice connection dropped. Tap Talk to start again.", true); if (t) heard(t); } });
        return io.start().then(function () { S.io = io; S.starting = false; S.conv = true; S.lastSpoken = ""; note(""); ui.talk(S); idle(); step(); },
          function (e) { S.starting = false; ui.talk(S); note((e && e.message) || "Could not start the microphone.", true); });
      };
      if (voice) return go(voice);
      return api({ action: "voiceStart", session: session }).then(function (r) { return go(r && r.voice); }, function () { S.starting = false; ui.talk(S); note("Could not reach the server for voice. Try again with signal.", true); });
    }

    // Trade the ticket for the session, the fields and the first voice tokens.
    function open(frag) {
      ui.status("Opening this visit…");
      return api({ action: "voiceExchange", ticket: frag.ticket, eventId: frag.eventId }).then(function (r) {
        if (!r || !r.ok) { ui.status((r && r.message) || "Could not open this visit."); ui.dead(); return null; }
        session = r.session; lists = r.lists || {}; S.title = r.model.title; S.client = r.model.client;
        ui.header(r.model.title, r.model.client); setFields(r.model.fields); ui.status(""); step();
        return r;
      }, function () { ui.status("Could not reach the server. Check the signal and tap Talk on the card again."); ui.dead(); return null; });
    }

    return { open: open, startTalk: startTalk, stopTalk: stopTalk, heard: heard, accept: accept, reject: reject, undo: doUndo, setMute: setMute, partial: partial, final: final,
      state: S, fields: function () { return fields; }, pending: function () { return pending; }, session: function () { return session; }, skip: function () { if (S.focus) skipped[S.focus] = true; step(); } };
  }

  // ---- The page ----
  function boot() {
    var $ = function (id) { return document.getElementById(id); };
    // #check&a=<web app address>: one fetch from this host to the web app, to see the browser lets the page read the answer.
    var chk = /^#check&a=(.+)$/.exec(location.hash);
    if (chk) {
      var app = decodeURIComponent(chk[1]);
      $("status").textContent = "Checking the connection…";
      fetch(app + (app.indexOf("?") > -1 ? "&" : "?") + "voiceping=1", { credentials: "omit", cache: "no-store" }).then(function (r) { return r.json(); })
        .then(function (j) { $("status").textContent = j && j.ok ? "Connected: this page can reach the web app." : "The web app answered, but not as expected."; }, function () { $("status").textContent = "Blocked: this page could not read the web app's answer."; });
      $("talk").disabled = true; $("mute").disabled = true; $("ask").hidden = true;
      return;
    }
    var frag = parseFragment(location.hash, location.hostname === "127.0.0.1"); // the local address is for tools/check-voice.js only
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* the ticket is spent anyway */ }
    var dead = false;
    var ui = {
      status: function (t) { $("status").textContent = t; $("status").hidden = !t; },
      dead: function () { dead = true; $("talk").disabled = true; $("mute").disabled = true; },
      header: function (title, client) { $("title").textContent = title; $("client").textContent = client; },
      note: function (t, bad) { var n = $("note"); n.hidden = !t; n.textContent = t || ""; n.classList.toggle("bad", !!bad); },
      question: function (t) { $("q").textContent = t; },
      transcript: function (t) { var e = $("tr"); e.hidden = !t; e.textContent = t ? "“" + t + "”" : ""; },
      pending: function (c) { $("conf").hidden = !c; $("ask").hidden = !!c; if (c) $("confT").textContent = c.say; },
      chips: function (list) {
        var box = $("chips"); box.innerHTML = ""; box.hidden = !list.length;
        list.forEach(function (c) { var d = document.createElement("div"); d.className = "chip"; d.textContent = c.labels.join(", "); if (c.undo.length) { var b = document.createElement("button"); b.type = "button"; b.textContent = "Undo"; b.onclick = function () { ctl.undo(); }; d.appendChild(b); } box.appendChild(d); });
      },
      fields: function (list) {
        var ul = $("fields"), prev = ul._seen || {}; ul.innerHTML = ""; ul._seen = {};
        list.filter(function (f) { return f.value && f.kind !== "note"; }).forEach(function (f) {
          var li = document.createElement("li"), a = document.createElement("span"), b = document.createElement("b");
          a.textContent = f.label; b.textContent = shown(f, f.value); li.appendChild(a); li.appendChild(b);
          if (prev[f.key] !== undefined && prev[f.key] !== f.value) li.className = "flash";
          ul._seen[f.key] = f.value; ul.appendChild(li);
        });
        $("fieldsBox").hidden = !ul.children.length;
      },
      talk: function (S) {
        var live = S.conv, sp = live && S.io && S.io.speaking();
        $("talk").classList.toggle("live", live); $("talk").classList.toggle("busy", S.busy); $("talk").setAttribute("aria-pressed", String(live));
        $("talkT").textContent = S.starting ? "Starting…" : !live ? "Talk" : sp ? "Speaking…" : S.busy ? "Working…" : "Listening…";
        var m = $("mute"); m.setAttribute("aria-pressed", String(S.mute)); m.textContent = S.mute ? "🔇" : "🔊"; m.setAttribute("aria-label", S.mute ? "Voice is muted. Tap to unmute" : "Mute the voice");
      }
    };
    if (!frag) { ui.status("This page opens from Talk on the job card. Go back to the card and tap Talk."); ui.dead(); return; }
    var ctl = createController({ api: createApi(frag.app), ui: ui, io: window.VoiceIO, saveMute: function (m) { try { localStorage.setItem("vMute", m ? "1" : "0"); } catch (e) { /* private window */ } } });
    try { ctl.state.mute = localStorage.getItem("vMute") === "1"; } catch (e) { /* private window */ }
    ui.talk(ctl.state);
    var openedAt = Date.now(); // the tokens minted with the ticket are used only if the first tap comes soon; later a fresh set is asked for
    ctl.open(frag).then(function (r) { if (r && r.voice && r.voice.ok) window.__firstVoice = r.voice; });
    var b = $("talk"), t0 = 0, was = false;
    // Issue 200: the press unlocks sound; Talk starts on the lift of the finger, the gesture iPhone Safari counts for the
    // microphone and the sound context (a start on pointerdown hung at "Starting the microphone…" with no mic prompt).
    b.addEventListener("pointerdown", function (e) {
      e.preventDefault(); if (dead) return; try { b.setPointerCapture(e.pointerId); } catch (x) { /* older Safari */ }
      t0 = Date.now(); was = ctl.state.conv; if (window.VoiceIO) window.VoiceIO.unlock();
    });
    b.addEventListener("pointerup", function (e) {
      e.preventDefault(); if (dead) return; var held = Date.now() - t0 >= HOLD_MS;
      if (!was) { var v = Date.now() - openedAt < 60000 ? window.__firstVoice : null; window.__firstVoice = null; ctl.startTalk(v); }
      else if (!held) { ctl.stopTalk(); ui.note("Voice stopped."); } else if (ctl.state.io) ctl.state.io.commit();
    });
    b.addEventListener("pointercancel", function (e) { e.preventDefault(); });
    b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    b.addEventListener("keydown", function (e) { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); if (dead) return; if (ctl.state.conv) ctl.stopTalk(); else ctl.startTalk(); } });
    $("mute").addEventListener("click", function () { ctl.setMute(!ctl.state.mute); });
    $("yes").addEventListener("click", function () { ctl.accept(); });
    $("no").addEventListener("click", function () { ctl.reject(); });
    $("skip").addEventListener("click", function () { ctl.skip(); });
    document.addEventListener("visibilitychange", function () { if (document.hidden && ctl.state.conv) { ctl.stopTalk(); ui.note("Voice stopped while the page was in the background. Tap Talk to go on."); } });
    window.__voice = ctl;
  }

  var api = { parseFragment: parseFragment, redact: redact, norm: norm, command: command, money: money, fmt: fmt, readBack: readBack, plan: plan, nextField: nextField, question: question,
    createApi: createApi, createController: createController, boot: boot, UNDO_MS: UNDO_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById("talk")) boot();
  return api;
})();
