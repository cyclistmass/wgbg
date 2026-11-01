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
      loaded = { auth, fs, au, db };
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
        return (await auth.signInAnonymously(au)).user.uid;
      }).then(ok, e => fail(words(e)));
    },

    /** Signed in with Google now (seats say so, as the app's do). */
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
        await auth.signInAnonymously(au);
        return withAccount(au, {});
      }).then(ok, e => fail(words(e)));
    },

    /** A new room, in a transaction that first checks the code is free (the app's create). */
    create(id, doc, ok, fail) {
      load().then(({ fs, db }) => fs.runTransaction(db, async t => {
        const ref = fs.doc(db, "games", id);
        if ((await t.get(ref)).exists()) throw new Error("Room code already used");
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

    unobserve(handle) {
      const w = watching.get(handle);
      if (!w) return;
      w.closed = true;
      w.stops.forEach(stop => stop());
      watching.delete(handle);
    },
  };
})();
