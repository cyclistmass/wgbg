"use strict";
// A crash in the browser goes up by itself (#372, Mauro 2026-11-12: web crashes to Firebase on their own): the first
// uncaught error or unhandled rejection of a page load (a Kotlin exception the game didn't catch is one) becomes a
// "WGBG crash report" in Firestore `crashes`, through fire.js's report(), the Report button's path, so read_reports.js
// and reports_digest.js read it with the phones' crash reports. Loaded first, before the game, so a crash while the page
// loads counts too: it waits for fire.js and the guest sign-in, and is dropped quietly when either fails.
//
// What goes: the error and its whole stack, the build (globalThis.wgbgBuild: version and commit), the screen the game
// shows, the page's size and pixel ratio, the memory, the user agent and the seconds since load. Never a name, a note,
// a game or a chat. At most one per page load and PER_DAY a day on this browser (localStorage, when it can be read).
(() => {
  const PER_DAY = 3;
  const KEY = "wgbg-crash-sent";
  const MAX = 190000;   // ReportText.UPLOAD_MAX: under the rules' 200000
  const started = Date.now();
  const memories = new Set();

  /** Whether another report may go today, counting this one if so; storage that can't be used never blocks one. */
  function allow(storage, now) {
    const day = new Date(now).toISOString().slice(0, 10);
    let n = 0;
    try {
      const kept = JSON.parse(storage.getItem(KEY) || "null");
      if (kept && kept.day === day) n = Number(kept.n) || 0;
    } catch (e) {}
    if (n >= PER_DAY) return false;
    try { storage.setItem(KEY, JSON.stringify({ day, n: n + 1 })); } catch (e) {}
    return true;
  }

  const mb = b => (b / 1048576).toFixed(1) + " MB";

  /** The report's text in the layout the reports tools read (header, "key: value" fields, then "stack:" last): JS, as a crash may leave no wasm to ask. */
  function format(i) {
    const line = s => String(s == null ? "?" : s).replace(/[\r\n]+/g, " ").slice(0, 2000);
    const head = [
      "WGBG crash report",
      "version: " + line(i.version),
      "commit: " + line(i.commit),
      "source: web",
      "device: " + line(i.userAgent),
      "screen: " + `${i.width}x${i.height} px, dpr ${i.dpr}`,
      "page: " + line(i.screen),
      "time: " + new Date(i.now).toISOString(),
      "since load: " + (Math.max(0, i.now - i.started) / 1000).toFixed(1) + " s",
      "memory: " + line(i.memory),
      "error: " + line(i.error),
      "stack:",
    ].join("\n") + "\n";
    return (head + String(i.stack || "(none)").replace(/\r\n?/g, "\n")).slice(0, MAX - 1).trimEnd() + "\n";
  }

  /** The wasm memories the page made (Skia's and the game's) and the JS heap where the browser tells it. */
  function memory() {
    const parts = [];
    try { for (const m of memories) parts.push(mb(m.buffer.byteLength)); } catch (e) {}
    let out = parts.length ? "wasm " + parts.join(" + ") : "wasm ?";
    try { if (performance.memory) out += ", JS heap " + mb(performance.memory.usedJSHeapSize); } catch (e) {}
    return out;
  }

  // Every instance's exported memory, as the page makes them: nothing else changes in how a module loads.
  function keep(result) {
    try {
      const inst = result && (result.instance || result);
      for (const v of Object.values((inst && inst.exports) || {})) if (v instanceof WebAssembly.Memory) memories.add(v);
    } catch (e) {}
    return result;
  }
  try {
    // And memories made by the page's own code (an emscripten module may make its memory and hand it in).
    const Real = WebAssembly.Memory;
    const Memory = function (descriptor) { const m = new Real(descriptor); memories.add(m); return m; };
    Memory.prototype = Real.prototype;
    WebAssembly.Memory = Memory;
  } catch (e) {}
  try {
    for (const name of ["instantiate", "instantiateStreaming"]) {
      const real = WebAssembly[name];
      if (typeof real === "function") WebAssembly[name] = function () { return real.apply(this, arguments).then(keep); };
    }
  } catch (e) {}

  let taken = false, queued = null;

  function send(text) {
    const fire = globalThis.wgbgFire;
    if (!fire) { queued = text; return; }
    queued = null;
    try { fire.signIn(() => fire.report(text, "[]", () => {}, () => {}), () => {}); } catch (e) {}
  }

  function crashed(error, fallback) {
    if (taken) return;
    taken = true;
    try {
      const now = Date.now();
      let storage = null;
      try { storage = globalThis.localStorage; } catch (e) {}
      if (storage && !allow(storage, now)) return;
      const build = globalThis.wgbgBuild || {};
      const name = error && error.name, message = error && error.message;
      send(format({
        version: build.version, commit: build.commit, userAgent: navigator.userAgent,
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screen: globalThis.__wgbgScreen || "(loading)",
        now, started, memory: memory(),
        error: message != null ? (name ? name + ": " : "") + message : error != null ? fallback + ": " + String(error) : fallback,
        stack: error && error.stack,
      }));
    } catch (e) {}
  }

  addEventListener("error", e => {
    // A script or picture that didn't load is an error event too, with no error: only the page's own errors count.
    if (e && (e.error || e.message)) crashed(e.error, e.message || "error");
  });
  addEventListener("unhandledrejection", e => crashed(e && e.reason, "Unhandled rejection"));

  globalThis.wgbgCrash = {
    /** fire.js is on the page: a report a crash queued while it loaded goes now. */
    fireReady() { if (queued) send(queued); },
    // For tools/test_web_crash.py only.
    format, allow, PER_DAY, KEY,
  };
})();
