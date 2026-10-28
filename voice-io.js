/*
 * VoiceIO (inbox 148, rows 32 to 34): the phone's ear and mouth, shared by the job card and Setup's Test mic.
 * The server (Voice.gs voiceSession) mints a short-lived token for the chosen provider; this file opens the sockets
 * itself, so the real keys never reach the browser. ElevenLabs is primary (Scribe v2 Realtime ear, Flash v2.5 mouth),
 * Deepgram (Nova-3 ear, Aura mouth) the fallback behind the same interface. Safari's own dictation is not used.
 *
 *   const io = VoiceIO.create(session, { onPartial(text), onFinal(text), onError(message), onClose() });
 *   io.start()  -> Promise, resolves when the microphone and the ear socket are open
 *   io.commit() -> end the utterance now (hold to talk released)
 *   io.speak(text, getToken) -> Promise, resolves when the sentence has been spoken or was cut off
 *   io.hush()   -> stop speaking at once (barge-in, mute)
 *   io.speaking() -> true while the mouth is talking
 *   io.stop()   -> close the microphone, both sockets and the speaker
 * Transcripts and audio are never stored or logged here.
 */
window.VoiceIO = (function () {
  var EAR_RATE = 16000;
  function b64(bytes) { var s = ""; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(t) { var s = atob(t), n = s.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = s.charCodeAt(i); return u; }
  // Float samples at the microphone's rate down to 16 bit little endian PCM at the ear's rate.
  function toPcm16(f32, inRate, outRate) {
    var ratio = inRate / outRate, n = Math.floor(f32.length / ratio), out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * ratio), b = Math.min(f32.length, Math.floor((i + 1) * ratio)), sum = 0, c = 0;
      for (var j = a; j < b; j++) { sum += f32[j]; c++; }
      var v = Math.max(-1, Math.min(1, c ? sum / c : f32[a] || 0));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return new Uint8Array(out.buffer);
  }
  function fromPcm16(bytes, ctx, rate) {
    var n = bytes.length >> 1, dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2), buf = ctx.createBuffer(1, n, rate), ch = buf.getChannelData(0);
    for (var i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 0x8000;
    return buf;
  }
  function query(pairs) { return pairs.map(function (p) { return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]); }).join("&"); }

  // iOS only lets a sound context start inside a tap: the button calls this on pointerdown, the session reuses it.
  var shared = null;
  function unlock() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      if (!shared && Ctx) shared = new Ctx();
      if (shared && shared.state === "suspended" && shared.resume) shared.resume();
      if (shared) { var b = shared.createBuffer(1, 1, 22050), s = shared.createBufferSource(); s.buffer = b; s.connect(shared.destination); s.start(0); }
    } catch (e) { /* the session makes its own */ }
  }

  function create(sess, h) {
    var ctx = null, stream = null, node = null, src = null, ear = null, closed = false, open = false;
    var playing = [], nextAt = 0, mouth = null, dgBuf = "", dgTimer = null;
    var eleven = sess.provider !== "deepgram";
    function fail(m) { if (closed) return; try { h.onError && h.onError(m); } catch (e) { /* the page handles it */ } }
    function sendAudio(pcm) {
      if (!ear || ear.readyState !== 1) return;
      if (eleven) ear.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(pcm), commit: false, sample_rate: EAR_RATE }));
      else ear.send(pcm);
    }
    function emit(t) { t = String(t || "").replace(/\s+/g, " ").trim(); if (t && h.onFinal) h.onFinal(t); }
    function earOnMessage(ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (eleven) {
        var t = m.message_type;
        if (t === "partial_transcript") h.onPartial && h.onPartial(m.text || "");
        else if (t === "committed_transcript" || t === "committed_transcript_with_timestamps") emit(m.text);
        else if (/auth_error|quota_exceeded|rate_limited|unaccepted_terms|session_time_limit|resource_exhausted/.test(t || "")) fail(t === "auth_error" ? "The speech provider refused the token." : t === "quota_exceeded" ? "The speech provider is out of credit." : "The speech provider stopped the session (" + t + ").");
        return;
      }
      if (m.type === "Results" && m.channel && m.channel.alternatives && m.channel.alternatives[0]) {
        var tx = m.channel.alternatives[0].transcript || "";
        if (m.is_final) { dgBuf += (tx ? tx + " " : ""); if (m.speech_final) { var out = dgBuf; dgBuf = ""; emit(out); } else h.onPartial && h.onPartial(dgBuf); }
        else h.onPartial && h.onPartial(dgBuf + tx);
      } else if (m.type === "UtteranceEnd" && dgBuf) { var o2 = dgBuf; dgBuf = ""; emit(o2); }
    }
    // Issue 200 (October 28): a step that never answers (the iPhone's mic prompt, a speech socket that neither opens nor
    // fails) used to leave Talk on "Starting…" forever. Each step gets 15 seconds and its own message.
    var STEP_MS = 15000;
    function within(p, msg) {
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { reject(new Error(msg)); }, STEP_MS);
        p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
      });
    }
    function step(name) { try { h.onStep && h.onStep(name); } catch (e) { /* the page paints it */ } }
    function openEar() {
      return new Promise(function (resolve, reject) {
        var e = sess.ear, terms = sess.terms || [], url, ws;
        if (eleven) {
          var q = [["model_id", e.model], ["audio_format", "pcm_" + EAR_RATE], ["commit_strategy", "vad"], ["language_code", "en"], ["token", e.token]];
          terms.forEach(function (t) { q.push(["keyterms", t]); });
          url = e.url + "?" + query(q); ws = new WebSocket(url);
        } else {
          var d = [["model", e.model], ["encoding", "linear16"], ["sample_rate", EAR_RATE], ["channels", 1], ["language", "en"], ["interim_results", "true"], ["smart_format", "true"], ["endpointing", 700], ["utterance_end_ms", 1500]];
          terms.forEach(function (t) { d.push(["keyterm", t]); });
          url = e.url + "?" + query(d); ws = new WebSocket(url, ["bearer", e.token]);
        }
        ws.binaryType = "arraybuffer"; var settled = false;
        ws.onopen = function () { if (!settled) { settled = true; resolve(ws); } };
        ws.onmessage = earOnMessage;
        ws.onerror = function () { if (!settled) { settled = true; reject(new Error("Could not reach the speech service.")); } else fail("The speech connection broke."); };
        ws.onclose = function () { if (!settled) { settled = true; reject(new Error("The speech service closed the connection.")); } else if (!closed) { try { h.onClose && h.onClose(); } catch (x) { /* ignore */ } } };
      });
    }
    // Why the microphone failed. Inside Google's frame the page may be barred from the microphone by the frame itself
    // (Permissions-Policy), which no phone setting fixes; only say "Settings" when the policy allows it.
    function micMessage(e) {
      var n = String((e && e.name) || "") + String((e && e.message) || "");
      if (!/denied|NotAllowed|Permission|Security/i.test(n)) return "No microphone found.";
      var p = document.permissionsPolicy || document.featurePolicy, blocked = false;
      try { blocked = !!(p && p.allowsFeature && !p.allowsFeature("microphone")); } catch (x) { blocked = false; }
      var framed = false;
      try { framed = window.top !== window.self; } catch (x) { framed = true; }
      if (framed) return "The app's Google frame blocks the microphone. Your phone settings are fine. Voice needs its own page; the office is setting it up.";
      if (blocked) return "Google's page frame blocks the microphone here, so no setting will fix it. Use the Talk screen outside the Apps Script frame.";
      return "The microphone is off for this page. On the iPhone: Settings, Safari, Microphone, set to Ask or Allow. Then close the tab, reopen the card and tap Talk. Or tap aA in the address bar, Website Settings, Microphone, Allow.";
    }
    function openMic() {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error("This browser cannot use the microphone."));
      ctx = shared || new Ctx();
      // Issue 200: ask for the microphone first. On iOS a suspended context's resume() never settles without a gesture
      // Safari counts, and waiting on it before getUserMedia meant the mic prompt never came. resume() runs after, unawaited.
      step("mic");
      return within(navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }), "The microphone did not answer. Tap Talk again.").then(function (s) {
        try { if (ctx.state === "suspended" && ctx.resume) ctx.resume(); } catch (e) { /* plays once a gesture lands */ }
        stream = s; src = ctx.createMediaStreamSource(s);
        node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = function (e) { if (open) sendAudio(toPcm16(e.inputBuffer.getChannelData(0), ctx.sampleRate, EAR_RATE)); };
        var mute = ctx.createGain(); mute.gain.value = 0; src.connect(node); node.connect(mute); mute.connect(ctx.destination);
      }, function (e) { throw new Error(micMessage(e)); });
    }

    // ---- the mouth ----
    function playChunk(bytes, rate) {
      if (!ctx || !bytes.length) return;
      var buf = fromPcm16(bytes, ctx, rate), s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination);
      nextAt = Math.max(nextAt, ctx.currentTime + 0.03); s.start(nextAt); nextAt += buf.duration; playing.push(s);
      s.onended = function () { playing = playing.filter(function (x) { return x !== s; }); if (mouth && mouth.done && !playing.length) mouth.finish(); };
    }
    function speak(text, getToken) {
      hush();
      return new Promise(function (resolve) {
        var m = mouth = { done: false, ws: null, finished: false };
        m.finish = function () { if (m.finished) return; m.finished = true; if (mouth === m) mouth = null; try { m.ws && m.ws.close(); } catch (e) { /* closed */ } resolve(); };
        var go = function (tok) {
          if (m.finished) return;
          var mo = sess.mouth, ws;
          try {
            if (eleven) ws = new WebSocket(mo.url + "?" + query([["model_id", mo.model], ["output_format", "pcm_" + mo.rate], ["single_use_token", tok], ["language_code", "en"], ["inactivity_timeout", 20]]));
            else ws = new WebSocket(mo.url + "?" + query([["model", mo.model], ["encoding", "linear16"], ["sample_rate", mo.rate]]), ["bearer", tok]);
          } catch (e) { m.finish(); return; }
          ws.binaryType = "arraybuffer"; m.ws = ws;
          ws.onopen = function () {
            if (eleven) { ws.send(JSON.stringify({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.05 }, generation_config: { chunk_length_schedule: [50, 120, 200, 260] } })); ws.send(JSON.stringify({ text: text + " ", try_trigger_generation: true })); ws.send(JSON.stringify({ text: "" })); }
            else { ws.send(JSON.stringify({ type: "Speak", text: text })); ws.send(JSON.stringify({ type: "Flush" })); }
          };
          ws.onmessage = function (ev) {
            if (typeof ev.data !== "string") { playChunk(new Uint8Array(ev.data), mo.rate); return; }
            var j; try { j = JSON.parse(ev.data); } catch (e) { return; }
            if (eleven) { if (j.audio) playChunk(unb64(j.audio), mo.rate); if (j.isFinal) { m.done = true; if (!playing.length) m.finish(); } }
            else if (j.type === "Flushed") { m.done = true; if (!playing.length) m.finish(); }
          };
          ws.onerror = function () { m.done = true; if (!playing.length) m.finish(); };
          ws.onclose = function () { m.done = true; if (!playing.length) m.finish(); };
        };
        var first = sess.mouth && sess.mouth.token && !sess.mouth.used;
        if (first) { sess.mouth.used = true; go(sess.mouth.token); }
        else if (getToken) getToken(function (tok) { if (tok) go(tok); else m.finish(); });
        else m.finish();
      });
    }
    function hush() {
      var m = mouth; mouth = null;
      playing.forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) { /* already over */ } });
      playing = []; nextAt = 0;
      if (m) { m.finished = true; try { m.ws && m.ws.close(); } catch (e) { /* closed */ } if (m.finish) { m.done = true; } }
    }
    function commit() {
      if (!ear || ear.readyState !== 1) return;
      if (eleven) ear.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(new Uint8Array(640)), commit: true, sample_rate: EAR_RATE }));
      else { ear.send(JSON.stringify({ type: "Finalize" })); clearTimeout(dgTimer); dgTimer = setTimeout(function () { var o = dgBuf; dgBuf = ""; emit(o); }, 700); }
    }
    function stop() {
      closed = true; open = false; hush(); clearTimeout(dgTimer);
      try { if (ear) { if (!eleven && ear.readyState === 1) ear.send(JSON.stringify({ type: "CloseStream" })); ear.close(); } } catch (e) { /* closed */ }
      try { node && node.disconnect(); src && src.disconnect(); } catch (e) { /* closed */ }
      try { stream && stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* closed */ }
      try { if (ctx && ctx !== shared) ctx.close(); } catch (e) { /* closed */ }
      ear = node = src = stream = ctx = null;
    }
    function start() {
      return openMic().then(function () { step("ear"); return within(openEar(), "The speech service did not answer. Check signal and tap Talk again."); })
        .then(function (ws) { ear = ws; open = true; }).catch(function (e) { stop(); throw e; });
    }
    return { start: start, stop: stop, commit: commit, speak: speak, hush: hush, speaking: function () { return !!mouth || playing.length > 0; } };
  }
  return { create: create, unlock: unlock };
})();
