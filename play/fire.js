"use strict";
// Firebase's JS SDK for the web game's online play (#233): globalThis.wgbgFire, which the game's FireStore.kt calls.
// It writes and reads the app's documents (games/{code} and games/{code}/moves/{seq}) the way the app's
// FirestoreTransport does: documents arrive from Kotlin as JSON in RoomWire's form, with {"$serverTime":true},
// {"$inDays":n} and {"$millis":ms} standing for the values only Firestore makes; timestamps go back as {"$millis":ms}.
// The SDK loads on first use, a pinned version from Google's CDN; firebase-config.js says which project.
(() => {
  const VERSION = "11.10.0";
  const BASE = `https://www.gstatic.com/firebasejs/${VERSION}/`;
  let loading = null;

  function load() {
    if (!loading) loading = (async () => {
      const [app, auth, fs] = await Promise.all(["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map(f => import(BASE + f)));
      const cfg = globalThis.wgbgFirebaseConfig;
      const a = app.initializeApp(cfg.options, "wgbg");
      const au = auth.getAuth(a);
      const db = fs.getFirestore(a);
      if (cfg.emulator) {
        auth.connectAuthEmulator(au, `http://${cfg.emulator.host}:${cfg.emulator.authPort}`, { disableWarnings: true });
        fs.connectFirestoreEmulator(db, cfg.emulator.host, cfg.emulator.firestorePort);
      }
      loaded = { auth, fs, au, db, app: a };
      return loaded;
    })();
    return loading;
  }

  // ---- Google sign-in (#83), as the app's GoogleAccount: anonymous stays the default (no sign-in wall). Signing in links
  // Google to the guest account this browser already has, so its player id and its seats in rooms carry on; a Google
  // account that already belongs to another player id is switched to (this browser's guest games stay with the guest).
  // Signing out gives a fresh guest. A popup first; only where a popup can't open, a redirect (the page comes back and
  // account() finishes it), except in WebKit, where a redirect can't finish.
  let loaded = null;
  const REDIRECT = "wgbg-web-google-redirect";
  /** Safari, or any browser on iPhone/iPad (all WebKit there): not Chrome, Edge, Opera or Android on their own engines. */
  const webkitOnly = () => {
    const ua = navigator.userAgent;
    return /AppleWebKit/.test(ua) && (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) || !/Chrome|Chromium|Edg|OPR|Android/.test(ua));
  };
  const isGoogleUser = u => !!u && u.providerData.some(p => p.providerId === "google.com");
  // A guest made by an automated browser (our tests: Playwright sets navigator.webdriver) carries this photo address,
  // so the player count (.claude/tools/players.js) can tell our tests from new players (Mauro, 2026-11-11). Nothing in
  // the game reads a guest's photo; the .invalid domain never resolves. A person's browser never sets it.
  const TEST_GUEST_MARK = "https://test.invalid/wgbg";
  async function guest(auth, au) {
    const u = (await auth.signInAnonymously(au)).user;
    if (typeof navigator !== "undefined" && navigator.webdriver) { try { await auth.updateProfile(u, { photoURL: TEST_GUEST_MARK }); } catch (e) {} }
    return u;
  }

  function accountOf(u) {
    const g = u && u.providerData.find(p => p.providerId === "google.com");
    return { uid: u ? u.uid : "", google: !!g, email: (g && g.email) || (u && u.email) || "", name: (g && g.displayName) || (u && u.displayName) || "" };
  }
  const session = {
    get: k => { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del: k => { try { sessionStorage.removeItem(k); } catch (e) {} },
  };
  /**
   * Runs a sign-in ([run]: a popup, or a redirect's result) for the player who was [before] ("" for nobody yet):
   * "linked" (same player id), "signed" (there was none), "switched" (the Google account was another player id's) or
   * "cancelled".
   */
  async function finishGoogle({ auth, au }, before, run) {
    try {
      const r = await run();
      if (!r) return { outcome: "cancelled" };
      return { outcome: !before ? "signed" : r.user.uid === before ? "linked" : "switched" };
    } catch (e) {
      if (e && e.code === "auth/credential-already-in-use") {
        const cred = auth.GoogleAuthProvider.credentialFromError(e);
        if (!cred) throw e;
        await auth.signInWithCredential(au, cred);
        return { outcome: "switched" };
      }
      if (e && /^auth\/(popup-closed-by-user|cancelled-popup-request|user-cancelled)$/.test(e.code)) return { outcome: "cancelled" };
      throw e;
    }
  }
  const withAccount = (au, o) => JSON.stringify(Object.assign({ account: accountOf(au.currentUser) }, o));

  const DAY = 86400000;
  function toFire(fs, v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(x => toFire(fs, x));
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$serverTime") return fs.serverTimestamp();
    if (keys.length === 1 && keys[0] === "$inDays") return fs.Timestamp.fromMillis(Date.now() + v.$inDays * DAY);
    if (keys.length === 1 && keys[0] === "$millis") return fs.Timestamp.fromMillis(v.$millis);
    const out = {};
    for (const k of keys) out[k] = toFire(fs, v[k]);
    return out;
  }
  function fromFire(fs, v) {
    if (v === null || typeof v !== "object") return v;
    if (v instanceof fs.Timestamp) return { $millis: v.toMillis() };
    if (Array.isArray(v)) return v.map(x => fromFire(fs, x));
    const out = {};
    for (const k of Object.keys(v)) out[k] = fromFire(fs, v[k]);
    return out;
  }
  // The code first ("permission-denied: ..."), so the game can tell a room it may not read from one that isn't there.
  const words = e => (e && e.code ? `${e.code}: ` : "") + ((e && e.message) || String(e));

  const watching = new Map();
  let nextHandle = 1;

  // ---- The Realtime Database (#288) loads on first use, as its own module: a page that never opens a phone's room never
  // downloads it. Its address is the config's databaseURL (a live page without one can't open those rooms, and says so).
  const NO_DB = "Rooms made on phones (codes with four digits) need the Realtime Database, and this page has no address for it. " +
    "Add databaseURL to firebase-live.js: https://<project>-default-rtdb.firebaseio.com for the project in .firebaserc";
  let loadingDb = null;
  function loadDb() {
    if (!loadingDb) loadingDb = (async () => {
      const L = await load();
      const cfg = globalThis.wgbgFirebaseConfig;
      if (!cfg.options.databaseURL) throw new Error(NO_DB);
      const rt = await import(BASE + "firebase-database.js");
      const rdb = rt.getDatabase(L.app, cfg.options.databaseURL);
      if (cfg.emulator) rt.connectDatabaseEmulator(rdb, cfg.emulator.host, cfg.emulator.dbPort);
      return { rt, rdb };
    })();
    return loadingDb;
  }
  /** Markers to the database's values: the server's clock, a day count ahead of this device's clock, a fixed moment. */
  function toRtdb(rt, v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(x => toRtdb(rt, x));
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$serverTime") return rt.serverTimestamp();
    if (keys.length === 1 && keys[0] === "$inDays") return Date.now() + v.$inDays * DAY;
    if (keys.length === 1 && keys[0] === "$millis") return v.$millis;
    const out = {};
    for (const k of keys) out[k] = toRtdb(rt, v[k]);
    return out;
  }
  /** Moves this page is writing ("{code}/{key}"): their echoes wait for the server's answer. */
  const inflight = new Set();
  /** Tells every watcher of room [code] that the server has move [key]. */
  function tell(code, key, value) {
    for (const w of watching.values()) if (w.code === code && w.tell) w.tell(key, value);
  }

  globalThis.wgbgFire = {
    /** Anonymous sign-in, as the app's guests: a remembered one if the server still knows it, else a fresh one. */
    signIn(ok, fail) {
      load().then(async ({ auth, au }) => {
        await au.authStateReady();
        const saved = au.currentUser;
        if (saved) {
          try { await saved.getIdToken(true); return saved.uid; } catch (e) {
            // A Google account is kept through a network hiccup; only one the server no longer knows is dropped.
            if (isGoogleUser(saved) && !/^auth\/(user-not-found|user-disabled|user-token-expired|invalid-user-token)$/.test(e && e.code)) throw e;
            await auth.signOut(au);
          }
        }
        return (await guest(auth, au)).uid;
      }).then(ok, e => fail(words(e)));
    },

    /** Signed in with Google now (seats say so). */
    isGoogle() { return !!loaded && isGoogleUser(loaded.au.currentUser); },

    /**
     * Who this browser is, as JSON {account: {uid, google, email, name}} ("" uid before anyone signed in), finishing a
     * Google sign-in that went by redirect first ({outcome} then says how it went). Signs nobody in by itself.
     */
    account(ok, fail) {
      load().then(async L => {
        await L.au.authStateReady();
        const before = session.get(REDIRECT);
        if (!before) return withAccount(L.au, {});
        session.del(REDIRECT);
        return withAccount(L.au, await finishGoogle(L, before === "-" ? "" : before, () => L.auth.getRedirectResult(L.au)));
      }).then(ok, e => fail(words(e)));
    },

    /**
     * Sign in with Google from a tap: {account, outcome} ("linked", "signed", "switched", "cancelled", "redirect" as the
     * page leaves for Google's, or "blocked": no popup and no redirect that would come back). Called with nothing
     * awaited first once the SDK is in, as Safari opens popups only straight from a tap.
     */
    signInGoogle(ok, fail) {
      const go = L => {
        const { auth, au } = L;
        const provider = new auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const user = au.currentUser, before = user ? user.uid : "";
        return finishGoogle(L, before, () => user ? auth.linkWithPopup(user, provider) : auth.signInWithPopup(au, provider))
          .catch(async e => {
            if (!(e && /^auth\/(popup-blocked|operation-not-supported-in-this-environment)$/.test(e.code))) throw e;
            // Safari, and every browser on iPhone and iPad, keeps the sign-in helper's storage apart from the page's, so a
            // redirect comes back still a guest (web_signin.js sees it in WebKit): there, ask for the popup instead.
            if (webkitOnly()) return { outcome: "blocked" };
            session.set(REDIRECT, before || "-");
            if (user) await auth.linkWithRedirect(user, provider); else await auth.signInWithRedirect(au, provider);
            return { outcome: "redirect" };
          }).then(o => withAccount(au, o));
      };
      (loaded ? go(loaded) : load().then(go)).then(ok, e => fail(words(e)));
    },

    /** Sign out: a fresh guest from then on ({account}). */
    signOutGoogle(ok, fail) {
      load().then(async ({ auth, au }) => {
        await auth.signOut(au);
        await guest(auth, au);
        return withAccount(au, {});
      }).then(ok, e => fail(words(e)));
    },

    /**
     * A new room, in a transaction that first checks the code is free (the app's create). A code taken by a game you
     * aren't in can't even be read (the rules show it only to its players; the browser logs the refused read): that
     * code is in use too, and the game tries another (#275).
     */
    create(id, doc, ok, fail) {
      load().then(({ fs, db }) => fs.runTransaction(db, async t => {
        const ref = fs.doc(db, "games", id);
        const snap = await t.get(ref).catch(e => { throw e && e.code === "permission-denied" ? new Error("Room code already used") : e; });
        if (snap.exists()) throw new Error("Room code already used");
        t.set(ref, toFire(fs, JSON.parse(doc)));
      })).then(() => ok(), e => fail(words(e)));
    },

    /**
     * Reads the room and updates it in one transaction (the app's change): [f] gets the room as JSON ("" for none) and
     * answers with the fields to write, {"$skip":true} or {"$error":"..."}.
     */
    change(id, f, ok, fail) {
      load().then(({ fs, db }) => fs.runTransaction(db, async t => {
        const ref = fs.doc(db, "games", id);
        const snap = await t.get(ref);
        const out = JSON.parse(f(snap.exists() ? JSON.stringify(fromFire(fs, snap.data())) : ""));
        if (out.$error !== undefined) throw new Error(out.$error);
        if (out.$skip) return;
        t.update(ref, toFire(fs, out));
      })).then(() => ok(), e => fail(e && e.code ? words(e) : (e && e.message) || String(e)));
    },

    /** One move under its id: create-only, so a seq someone else took is refused (the app's submit). */
    submit(id, move, doc, ok, fail) {
      load().then(({ fs, db }) => fs.setDoc(fs.doc(db, "games", id, "moves", move), toFire(fs, JSON.parse(doc))))
        .then(() => ok(), e => fail(words(e)));
    },

    /**
     * The room and its moves after [afterSeq] (the app's observeMoves): every room snapshot, and each snapshot's moves
     * the server has confirmed (a local write still pending is a prediction, not a move), with whether it came from the cache.
     */
    observe(id, afterSeq, onRoom, onMoves, onError) {
      const handle = nextHandle++;
      const w = { stops: [], closed: false };
      watching.set(handle, w);
      load().then(({ fs, db }) => {
        if (w.closed) return;
        const ref = fs.doc(db, "games", id);
        w.stops.push(fs.onSnapshot(ref, { includeMetadataChanges: true },
          s => { if (!w.closed) onRoom(s.exists() ? JSON.stringify(fromFire(fs, s.data())) : ""); },
          e => { if (!w.closed) onError(words(e)); }));
        const q = fs.query(fs.collection(ref, "moves"), fs.orderBy("seq"), fs.where("seq", ">", Number(afterSeq)));
        w.stops.push(fs.onSnapshot(q, { includeMetadataChanges: true }, snap => {
          if (w.closed) return;
          const out = [];
          for (const c of snap.docChanges({ includeMetadataChanges: true })) {
            if (c.type !== "removed" && !c.doc.metadata.hasPendingWrites) out.push(fromFire(fs, c.doc.data()));
          }
          onMoves(JSON.stringify(out), snap.metadata.fromCache);
        }, e => { if (!w.closed) onError(words(e)); }));
      }, e => { if (!w.closed) onError(words(e)); });
      return handle;
    },

    /**
     * A bug report or idea (#255), as the app's sendCrash: {uid, report, createdAt} to `crashes`, then each picture (a
     * base64 JPEG) to `shots` as {uid, crash, n, image, createdAt}. [ok] gets how many pictures went: the report counts as
     * sent even if one is refused.
     */
    report(text, shotsJson, ok, fail) {
      load().then(async ({ fs, db, au }) => {
        const uid = au.currentUser.uid;
        const ref = await fs.addDoc(fs.collection(db, "crashes"), { uid, report: text, createdAt: fs.serverTimestamp() });
        const sent = await Promise.all(JSON.parse(shotsJson).map((image, n) =>
          fs.addDoc(fs.collection(db, "shots"), { uid, crash: ref.id, n, image, createdAt: fs.serverTimestamp() }).then(() => 1, () => 0)));
        return sent.reduce((a, b) => a + b, 0);
      }).then(ok, e => fail(words(e)));
    },

    // ---- Realtime Database rooms (#288): the app's RealtimeTransport, on the JS SDK. A room's code with four digits lives
    // here (what a phone makes since 0.3.9-pre6), two or three on Firestore; the page's RoutedStore picks by the digits. The
    // paths and formats are RtdbWire's: games/{code} (the room, in a transaction), moves/{code}/{seq} (one string per move).
    // Values cross as JSON with the same markers as above; the room's JSON is the database's own, not Firestore's.

    /** A new room at games/{code}: the rules let it be made only where none is, so a code in use is refused. */
    rtdbCreate(code, doc, ok, fail) {
      loadDb().then(({ rt, rdb }) => rt.set(rt.ref(rdb, "games/" + code), toRtdb(rt, JSON.parse(doc))))
        .then(() => ok(), e => fail(words(e)));
    },

    /**
     * Reads games/{code} and changes it in one transaction: [f] gets the room as JSON ("" for none) and answers with the
     * whole room to write, {"$skip":true} or {"$error":"..."} (as change() above). A room is read from the server first, so
     * the transaction starts from the room itself and a room that isn't there is told in [f]'s words; the transaction's own
     * first pass may still see nothing (the SDK's guess), and then writes nothing back and lets the server answer.
     */
    rtdbChange(code, f, ok, fail) {
      loadDb().then(async ({ rt, rdb }) => {
        const ref = rt.ref(rdb, "games/" + code);
        if (!(await rt.get(ref)).exists()) {
          const out = JSON.parse(f(""));
          throw new Error(out.$error !== undefined ? out.$error : "Unknown room");
        }
        let refusal = null, skipped = false;
        const res = await rt.runTransaction(ref, cur => {
          refusal = null; skipped = false;
          if (cur === null) return cur;
          try {
            const out = JSON.parse(f(JSON.stringify(cur)));
            if (out.$error !== undefined) { refusal = out.$error; return undefined; }
            if (out.$skip) { skipped = true; return undefined; }
            return toRtdb(rt, out);
          } catch (e) { refusal = (e && e.message) || String(e); return undefined; }
        }, { applyLocally: false });   // no local events: listeners only ever see the committed room
        if (refusal !== null) throw new Error(refusal);
        if (skipped) return;
        if (!res.committed) throw new Error("The room didn't change");
        if (!res.snapshot.exists()) throw new Error("Unknown room");
      }).then(() => ok(), e => fail(e && e.code ? words(e) : (e && e.message) || String(e)));
    },

    /**
     * One move under moves/{code}/{key}: a plain set of the node, create-only by the rules. Its own echo is held back until
     * the server has answered (a prediction isn't a move, as hasPendingWrites is for Firestore's); then it goes to the
     * room's watchers as confirmed. Refused (another phone took that seq), what the server holds there goes on instead.
     * With [dev] (this tab holds the seat, #238) movedev/{code}/{key} goes with it in the same write, which the rules check
     * against the seat's hold: a move from a tab that no longer holds the seat is refused.
     */
    rtdbSend(code, key, value, dev, ok, fail) {
      loadDb().then(async ({ rt, rdb }) => {
        const id = code + "/" + key, ref = rt.ref(rdb, "moves/" + id);
        inflight.add(id);
        try {
          if (dev) await rt.update(rt.ref(rdb), { ["moves/" + id]: value, ["movedev/" + id]: dev });
          else await rt.set(ref, value);
        } catch (e) {
          inflight.delete(id);
          const s = await rt.get(ref).catch(() => null);
          if (s && s.exists()) tell(code, key, s.val());
          throw e;
        }
        inflight.delete(id);
        tell(code, key, value);
      }).then(() => ok(), e => fail(words(e)));
    },

    /** A seated browser pushing a running game's expiry on (the app's renew); a refusal only costs the next move its turn. */
    rtdbSetExpire(code, at) {
      loadDb().then(({ rt, rdb }) => rt.set(rt.ref(rdb, "games/" + code + "/expireAt"), Number(at)))
        .catch(e => console.warn("The room's expiry wasn't renewed: " + words(e)));
    },

    // ---- Seat holds (#238, net's SeatHold): hold/{uid}/{code}, which of this player's devices plays their seat. Only the
    // player reads and writes their own; JSON in and out, "" for no node.

    /** The signed-in player's hold for room [code] as the server has it now. */
    rtdbHoldRead(uid, code, ok, fail) {
      loadDb().then(async ({ rt, rdb }) => {
        const s = await rt.get(rt.ref(rdb, `hold/${uid}/${code}`));
        return s.exists() ? JSON.stringify(s.val()) : "";
      }).then(ok, e => fail(words(e)));
    },

    /** Changes the hold in a transaction: [f] gets the node as JSON ("" for none) and gives the node to write; [ok] gets what was written. */
    rtdbHoldChange(uid, code, f, ok, fail) {
      loadDb().then(async ({ rt, rdb }) => {
        const ref = rt.ref(rdb, `hold/${uid}/${code}`);
        const res = await rt.runTransaction(ref, cur => JSON.parse(f(cur === null ? "" : JSON.stringify(cur))), { applyLocally: false });
        if (!res.committed || !res.snapshot.exists()) throw new Error("The seat wasn't claimed");
        return JSON.stringify(res.snapshot.val());
      }).then(ok, e => fail(words(e)));
    },

    /** Every change of the hold node; stopped with unobserve(handle). */
    rtdbHoldWatch(uid, code, onValue, onError) {
      const handle = nextHandle++;
      const w = { code: null, stops: [], closed: false, tell: null };
      watching.set(handle, w);
      loadDb().then(({ rt, rdb }) => {
        if (w.closed) return;
        w.stops.push(rt.onValue(rt.ref(rdb, `hold/${uid}/${code}`), s => { if (!w.closed) onValue(s.exists() ? JSON.stringify(s.val()) : ""); },
          e => { if (!w.closed) onError(words(e)); }));
      }).catch(e => { if (!w.closed) onError(words(e)); });
      return handle;
    },

    /** All of the player's holds, JSON {code: node}. */
    rtdbHoldList(uid, ok, fail) {
      loadDb().then(async ({ rt, rdb }) => {
        const s = await rt.get(rt.ref(rdb, `hold/${uid}`));
        return s.exists() ? JSON.stringify(s.val()) : "";
      }).then(ok, e => fail(words(e)));
    },

    rtdbHoldDrop(uid, code, ok, fail) {
      loadDb().then(({ rt, rdb }) => rt.remove(rt.ref(rdb, `hold/${uid}/${code}`))).then(() => ok(), e => fail(words(e)));
    },

    /** devices/{code}/{uid}: what this player plays the room on, for QA only (privacy policy 4a); a refusal changes nothing. */
    rtdbSetDevice(code, uid, doc, ok, fail) {
      loadDb().then(({ rt, rdb }) => rt.set(rt.ref(rdb, "devices/" + code + "/" + uid), toRtdb(rt, JSON.parse(doc))))
        .then(() => ok(), e => fail(words(e)));
    },

    /**
     * The room and its moves from [afterKey] on (the app's observeMoves). The room is read from the server first and given
     * before any move, so the roster naming a move's sender is there; then the live listeners. Moves come to [onMoves] as
     * JSON [[key, value], ...], the ones that arrive together in one call, with fromCache true only to say the connection is
     * down; on reconnecting, the room and the moves after the last one seen are read from the server before it says live.
     */
    rtdbObserve(code, afterKey, onRoom, onMoves, onError) {
      const handle = nextHandle++;
      const w = { code, stops: [], closed: false, tell: null };
      watching.set(handle, w);
      loadDb().then(async ({ rt, rdb }) => {
        if (w.closed) return;
        const roomRef = rt.ref(rdb, "games/" + code), movesRef = rt.ref(rdb, "moves/" + code);
        let lastRoom = null, highest = afterKey, connected = true;
        const room = s => {
          const text = s.exists() ? JSON.stringify(s.val()) : "";
          if (!w.closed && text !== lastRoom) { lastRoom = text; onRoom(text); }
        };
        room(await rt.get(roomRef));
        if (w.closed) return;
        let pending = [], scheduled = false;
        const flush = () => {
          scheduled = false;
          const out = pending.splice(0);
          if (!w.closed && out.length) onMoves(JSON.stringify(out), false);
        };
        w.tell = (key, value) => {
          if (key > highest) highest = key;
          pending.push([key, value]);
          if (!scheduled) { scheduled = true; Promise.resolve().then(flush); }
        };
        const fail = e => { if (!w.closed) onError(words(e)); };
        const child = s => { if (!w.closed && !inflight.has(code + "/" + s.key)) w.tell(s.key, s.val()); };
        const q = rt.query(movesRef, rt.orderByKey(), rt.startAt(afterKey));
        w.stops.push(rt.onValue(roomRef, room, fail), rt.onChildAdded(q, child, fail), rt.onChildChanged(q, child, fail));
        w.stops.push(rt.onValue(rt.ref(rdb, ".info/connected"), async s => {
          const up = s.val() === true;
          if (up === connected || w.closed) return;
          connected = up;
          if (!up) { onMoves("[]", true); return; }
          try {
            const [r, ms] = await Promise.all([rt.get(roomRef), rt.get(rt.query(movesRef, rt.orderByKey(), rt.startAt(highest)))]);
            if (w.closed || !connected) return;
            room(r);
            ms.forEach(c => { if (!inflight.has(code + "/" + c.key)) w.tell(c.key, c.val()); });
            await Promise.resolve();
            if (pending.length === 0 && !w.closed) onMoves("[]", false);
          } catch (e) { fail(e); }
        }));
      }).catch(e => { if (!w.closed) onError(words(e)); });
      return handle;
    },

    /**
     * The people this player played with (#72), from the same Firestore list as the app's (users/{uid}/met), as JSON
     * [{uid, name, lastPlayed (ms), games, starred}]; an entry missing a field is left out, as the app does. Signs nobody in.
     */
    friends(ok, fail) {
      load().then(async ({ fs, db, au }) => {
        await au.authStateReady();
        const me = au.currentUser;
        if (!me) return "[]";
        const out = [];
        (await fs.getDocs(fs.collection(db, "users", me.uid, "met"))).forEach(d => {
          const v = d.data();
          if (typeof v.name === "string" && v.lastPlayed && typeof v.lastPlayed.toMillis === "function" &&
              typeof v.games === "number" && typeof v.starred === "boolean")
            out.push({ uid: d.id, name: v.name, lastPlayed: v.lastPlayed.toMillis(), games: v.games, starred: v.starred });
        });
        return JSON.stringify(out);
      }).then(ok, e => fail(words(e)));
    },

    /**
     * Puts [uid] on this player's list (JSON {name, lastPlayed (ms), games, starred}) and, with the realtime store, the
     * marker its invite rule reads (/met/{me}/{uid}, #196), both at once, as the app's AccountService.putFriend.
     */
    putFriend(uid, json, ok, fail) {
      load().then(async ({ fs, db, au }) => {
        const me = au.currentUser;
        if (!me) throw new Error("Sign in first");
        const f = JSON.parse(json);
        const writes = [fs.setDoc(fs.doc(db, "users", me.uid, "met", uid),
          { name: String(f.name).slice(0, 80), lastPlayed: fs.Timestamp.fromMillis(f.lastPlayed), games: f.games, starred: f.starred })];
        if (globalThis.wgbgFirebaseConfig.options.databaseURL)
          writes.push(loadDb().then(({ rt, rdb }) => rt.update(rt.ref(rdb), { [`met/${me.uid}/${uid}`]: true })));
        await Promise.all(writes);
      }).then(() => ok(), e => fail(words(e)));
    },

    /** Takes [uid] off this player's list, and its marker. */
    forgetFriend(uid, ok, fail) {
      load().then(async ({ fs, db, au }) => {
        const me = au.currentUser;
        if (!me) throw new Error("Sign in first");
        const writes = [fs.deleteDoc(fs.doc(db, "users", me.uid, "met", uid))];
        if (globalThis.wgbgFirebaseConfig.options.databaseURL)
          writes.push(loadDb().then(({ rt, rdb }) => rt.update(rt.ref(rdb), { [`met/${me.uid}/${uid}`]: null })));
        await Promise.all(writes);
      }).then(() => ok(), e => fail(words(e)));
    },

    /**
     * The rooms that invite this player (#72, the app's RealtimeTransport.observeInvites): their trusted list
     * (/invites/{uid}), and each room on it read whenever the list changes. [onRooms] gets JSON {uid, rooms: {code: the
     * room's JSON, or "" when it can't be read}}; the page's code decides which still invite them and clears the others
     * ([clearInvite]). Stopped with unobserve(handle).
     */
    watchInvites(onRooms, onError) {
      const handle = nextHandle++;
      const w = { code: null, stops: [], closed: false, tell: null };
      watching.set(handle, w);
      loadDb().then(async ({ rt, rdb }) => {
        const { au } = await load();
        await au.authStateReady();
        const me = au.currentUser;
        if (w.closed || !me) return;
        let round = 0;
        w.stops.push(rt.onValue(rt.ref(rdb, "invites/" + me.uid), async s => {
          const mine = ++round;
          const codes = s.exists() ? Object.keys(s.val()) : [];
          const rooms = {};
          await Promise.all(codes.map(async c => {
            try { const r = await rt.get(rt.ref(rdb, "games/" + c)); rooms[c] = r.exists() ? JSON.stringify(r.val()) : ""; }
            catch (e) { rooms[c] = ""; }
          }));
          if (!w.closed && mine === round) onRooms(JSON.stringify({ uid: me.uid, rooms }));
        }, e => { if (!w.closed) onError(words(e)); }));
      }).catch(e => { if (!w.closed) onError(words(e)); });
      return handle;
    },

    /** Clears this player's invite entry for room [code] (gone, started, or no longer inviting them). */
    clearInvite(code) {
      loadDb().then(async ({ rt, rdb }) => {
        const { au } = await load();
        if (au.currentUser) await rt.remove(rt.ref(rdb, `invites/${au.currentUser.uid}/${code}`));
      }).catch(() => {});
    },

    unobserve(handle) {
      const w = watching.get(handle);
      if (!w) return;
      w.closed = true;
      w.stops.forEach(stop => stop());
      watching.delete(handle);
    },
  };
})();
