// The 3D board (the app's live board, from its board module): the same tiles, numbers, roads, buildings and Bandit as the
// flat board, drawn with three.js from the app's own GLB models (served next to the page in models/).
// The page's SVG board stays on top of it, squashed to the same tilt, and keeps everything you tap (corners, paths,
// tiles for the Bandit), so a tap lands where it does on the flat board. Orthographic, as the app's camera: a point on
// the tile tops (height 0) is on screen exactly where the squashed SVG puts it.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Everything about the board (which model goes where, how big, how far toward the camera, the sea's level, the number
// faces) is the 3D board module's: the shared ModelScene places it (wgbg.models), LOOK.model3d holds the rest.
/** How far standing pieces lie back from the camera at board [tilt] (the app's liveLift), seen from [view] above the table. */
const liftOf = (tilt, view) => Math.max(0, Math.PI / 2 - view - tilt);

/** The app's liveModelMatrix: column-major, heading about Y, a [lift] about the camera's right axis. */
function modelMatrix(p, lift = 0, rotation = 0) {
  const c = Math.cos(p.hd) * p.s, s = Math.sin(p.hd) * p.s;
  const h = [c, 0, -s, 0, p.s * p.st, 0, s, 0, c];
  if (!lift) return [h[0], h[1], h[2], 0, h[3], h[4], h[5], 0, h[6], h[7], h[8], 0, p.x, p.h, p.z, 1];
  const ax = Math.cos(rotation), az = -Math.sin(rotation), ct = Math.cos(lift), st = Math.sin(lift), k = 1 - ct;
  const r = [ct + ax * ax * k, az * st, ax * az * k, -az * st, ct, ax * st, ax * az * k, -ax * st, ct + az * az * k];
  const m = [];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) {
    let sum = 0;
    for (let i = 0; i < 3; i++) sum += r[i * 3 + row] * h[col * 3 + i];
    m[col * 3 + row] = sum;
  }
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, p.x, p.h, p.z, 1];
}

/**
 * A number's face [text], painted as the module's numbers.face says (the app's runtime number texture, LiveNumberGlb.kt):
 * the numeral and its pips, in the face's hot ink for the [hot] numbers.
 */
function numberTexture(text, face, hot) {
  const n = +text, px = 256, c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d"), perUnit = px / (2 * face.r);
  g.fillStyle = hot.includes(n) ? face.hot : face.ink;
  g.font = `bold ${face.text * perUnit}px sans-serif`;
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  const m = g.measureText(text);
  const ascent = m.fontBoundingBoxAscent || face.text * perUnit * 0.93, descent = m.fontBoundingBoxDescent || face.text * perUnit * 0.24;
  g.fillText(text, px / 2, px / 2 - face.raise * (ascent + descent) + ascent);
  const pips = 6 - Math.abs(7 - n), plate = face.r * perUnit;
  for (let i = 0; i < pips; i++) {
    g.beginPath(); g.arc(px / 2 + (i - (pips - 1) / 2) * 0.12 * plate, px / 2 + face.pipsDown * plate, 0.05 * plate, 0, 2 * Math.PI); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/**
 * Makes the 3D board in [wrap] under the page's [svg]. [look]: the module's camera, sea and number face (LOOK.model3d);
 * [sea]: the water's colour (the theme's); [served]: the model files next to the page (models/index.json). [onReady]
 * runs whenever a model arrives, so the page can draw again; [onFail] when one can't load (offline, say). Gives
 * { draw(models, colourOf), served, tilt, canvas, project(x, h, z), status(), dispose() }.
 */
export function createBoard3d(wrap, svg, { tilt = 0.4, look, sea, served = [], onReady = () => {}, onFail = () => {} } = {}) {
  const canvas = document.createElement("canvas");
  canvas.id = "board3d";
  canvas.setAttribute("aria-hidden", "true");
  wrap.insertBefore(canvas, wrap.firstChild);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(sea);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a4a55, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-4, 10, 3);
  scene.add(sun);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: sea, roughness: 0.35, metalness: 0 }));
  water.rotation.x = -Math.PI / 2; water.position.y = look.level;
  scene.add(water);
  const pieces = new THREE.Group();
  scene.add(pieces);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

  // The app's models, each loaded once; a placement clones it (materials shared, tinted ones per colour).
  const loader = new GLTFLoader();
  const models = new Map(), tinted = new Map(), digits = new Map();
  let failed = "";
  function model(name) {
    if (!models.has(name)) {
      models.set(name, null);
      loader.load(`models/${name}.glb`, g => { models.set(name, g.scene); onReady(); },
        undefined, e => { failed = `${name}: ${e && e.message || e}`; console.warn("3D board", failed); onFail(failed); });
    }
    return models.get(name);
  }
  /** [name]'s material [m], the wood (and sails) painted in [colour] as the app's liveTint does. */
  function tint(m, colour) {
    if (!colour || !(m.name === "WoodBody" || m.name === "SailCloth")) return m;
    const key = `${m.uuid}|${colour}`;
    if (!tinted.has(key)) { const t = m.clone(); t.color = new THREE.Color(colour); tinted.set(key, t); }
    return tinted.get(key);
  }
  function digit(text) {
    if (!digits.has(text)) {
      const g = new THREE.PlaneGeometry(2 * look.face.r, 2 * look.face.r);
      g.rotateX(-Math.PI / 2);   // flat on the plate, its top toward the top of the screen (-z)
      const map = numberTexture(text, look.face, look.hot);
      digits.set(text, new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false })));
    }
    return digits.get(text);
  }

  let tiltNow = tilt, last = null;

  /** One of wgbg.models' placements: a model (or a painted number face), in its owner's colour, posed as the app poses it. */
  function place(p, colourOf) {
    let obj;
    if (p.face) obj = digit(p.face).clone();
    else {
      const src = model(p.m);
      if (!src) return null;
      obj = src.clone(true);
      const colour = p.o >= 0 ? colourOf(p.o) : null;
      if (colour) obj.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => tint(m, colour)) : tint(o.material, colour); });
    }
    const lift = p.lean ? liftOf(tiltNow, look.pieceView) : 0;
    // Standing pieces lean back (the app's liveStandingMatrix, unrotated), seen from the module's view above the table.
    const m = modelMatrix(p, -lift, 0);
    // Pieces slide toward the camera (no change on screen, orthographic) so the terrain never hides them (#95).
    const d = p.b;
    m[13] += d * Math.cos(tiltNow); m[14] += d * Math.sin(tiltNow);
    obj.matrixAutoUpdate = false;
    obj.matrix.fromArray(m);
    return obj;
  }

  /** Lines the camera up with the page's SVG: same box, and the SVG's user units (squashed by cos tilt) as the frustum. */
  function frame() {
    const wr = wrap.getBoundingClientRect(), r = svg.getBoundingClientRect(), ctm = svg.getScreenCTM();
    if (!r.width || !r.height || !ctm) return false;
    Object.assign(canvas.style, { left: `${r.left - wr.left}px`, top: `${r.top - wr.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    renderer.setSize(Math.round(r.width), Math.round(r.height), false);
    const offX = ctm.e - r.left, offY = ctm.f - r.top;
    camera.left = -offX / ctm.a; camera.right = (r.width - offX) / ctm.a;
    camera.top = offY / ctm.d; camera.bottom = -(r.height - offY) / ctm.d;
    // Eye up and toward the bottom of the screen; screen-up is (0, sin t, -cos t): a point (x, h, z) lands at
    // x across and z cos t - h sin t down, the app's LiveProjection.
    camera.position.set(0, 30 * Math.cos(tiltNow), 30 * Math.sin(tiltNow));
    camera.up.set(0, Math.sin(tiltNow), -Math.cos(tiltNow));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    return true;
  }

  /** Draws wgbg.models' [models] (its placements), each owner's pieces in [colourOf] their seat. */
  function draw(models, colourOf) {
    last = { models, colourOf };
    pieces.clear();
    for (const p of models.placements) { const o = place(p, colourOf); if (o) pieces.add(o); }
    if (frame()) renderer.render(scene, camera);
  }
  const resize = () => { if (last && frame()) renderer.render(scene, camera); };
  const observer = new ResizeObserver(resize);
  observer.observe(wrap);

  return {
    draw,
    /** The model files the page serves, for wgbg.models (it places only those). */
    served,
    get tilt() { return tiltNow; },
    canvas,
    /** Where the point (x, h, z) of the board is on screen (client pixels), as drawn now. */
    project(x, h, z) {
      const v = new THREE.Vector3(x, h, z).project(camera), r = canvas.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    },
    /** Every model this board needs has arrived (or one failed: then why). */
    status: () => ({ loading: [...models.values()].filter(m => m === null).length, failed, pieces: pieces.children.length }),
    dispose() {
      observer.disconnect();
      renderer.dispose();
      canvas.remove();
    },
  };
}
