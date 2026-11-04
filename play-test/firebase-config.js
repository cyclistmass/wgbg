"use strict";
// Which Firebase the web game's online play talks to (#233): the one place it is set.
//
// By default the local Firebase emulators with the demo project, as every test runs:
//   firebase emulators:start --only firestore,auth,database --project demo-wgbg
// ?emu=HOST:FIRESTORE_PORT:AUTH_PORT[:DATABASE_PORT] on the page's URL points it at emulators elsewhere (the tests use their
// own ports); the Realtime Database emulator's port is 9000 when left out (firebase.json's), so a URL from before it still works.
//
// TODO(live, #233): the live project's web app config. Firebase console > Project settings > Your apps > Add app > Web
// gives an object { apiKey, authDomain, projectId, appId, ... }: put it in LIVE below, and the page uses it unless the
// URL asks for the emulators. A web app's config is not a secret (it ships in every page), but the live project's App
// Check and the authorized domains (Authentication > Settings) must allow the page's site before it goes out.
//
// The live config also needs databaseURL (#288), for the Realtime Database, where the phones make their rooms (codes with
// four digits, like QUARRY-1688): "https://<project>-default-rtdb.firebaseio.com" for the default project in
// .firebaserc (the one place projects are named). Without it the page works as before, Firestore rooms (two or three digits) only, and says
// so plainly when a room with four digits is opened (fire.js, NO_DB).
globalThis.wgbgFirebaseConfig = (() => {
  // The live web app config comes from firebase-live.js, kept out of git like google-services.json (#233).
  const LIVE = globalThis.wgbgFirebaseLive || null;
  const emu = new URLSearchParams(location.search).get("emu");
  if (LIVE && !emu) return { options: LIVE, emulator: null };
  const [host, firestorePort, authPort, dbPort = "9000"] = (emu || "127.0.0.1:8080:9099").split(":");
  return {
    // The emulators take any key; the project id is a demo one, so nothing can reach a real project. The demo project's
    // default database is the one firebase.json's rules (database.rules.json) apply to, as the app's RTDB_EMULATOR_URL says.
    options: { apiKey: "demo-api-key-for-the-emulators", authDomain: "demo-wgbg.firebaseapp.com", projectId: "demo-wgbg", appId: "1:0:web:0",
      databaseURL: "https://demo-wgbg-default-rtdb.firebaseio.com" },
    emulator: { host, firestorePort: Number(firestorePort), authPort: Number(authPort), dbPort: Number(dbPort) },
  };
})();
