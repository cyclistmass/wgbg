// The 3D board of the shared game screen in the browser (#278 web-boards, Live3d.wasmJs.kt): the phone's board module and
// its own GLB models (served next to the page in models/), drawn with three.js as the web game's board3d.js draws its
// 3D board. The canvas lies under the page's Compose canvas, which is clear wherever the game draws nothing, and takes
// no input: every tap, overlay and HUD stays the game screen's.
//
// The app hands over a scene (scene(json): each placement's model, colours, shell) when the placements change, and a
// pose (pose(json): the board's box on the page, the camera and every placement's matrix) when the view moves; the
// matrices are the phone renderer's own (LiveScene.kt livePose), so models land exactly under the overlays.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// The sky, the lights and the sea's picture come with each scene from the board's theme module (#300: scene.light,
// scene.ocean). Only the units are the page's own: three.js intensity per phone lux, one factor per kind of light.
const PER_LUX = 2.6 / 80000;        // a directional light
const FILL_PER_LUX = 1.3 / 25000;   // the light from all round (the phone's indirect light, a hemisphere light here)
// The page's stand-in for the phone's wave shader: how its material dims and shines the sea's picture.
const OCEAN_TINT = [0.62, 0.7, 0.78], OCEAN_ROUGHNESS = 0.35;
const ART = "composeResources/com.mauro.wgbg.ui.res/drawable/";

let renderer, world, camera, canvas, water, pieces, lit = null, lights = [];
let items = [], face = null, lastPose = null, failed = "", failHandler = () => {};
const models = new Map(), tints = new Map(), digits = new Map();
const loader = new GLTFLoader();

function setup() {
  canvas = document.createElement("canvas");
  canvas.id = "live3d";
  canvas.setAttribute("aria-hidden", "true");
  // Under the Compose canvas (z-index -1 paints below the page's normal flow, above its background) and never tapped.
  Object.assign(canvas.style, { position: "fixed", zIndex: "-1", pointerEvents: "none", display: "none", left: "0", top: "0" });
  document.body.insertBefore(canvas, document.body.firstChild);
  // Below the page's content but above its background: the page's body its own stacking context.
  document.body.style.isolation = "isolate";
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);   // the pose's sizes are device pixels already
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  world = new THREE.Scene();
  water = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(...OCEAN_TINT), roughness: OCEAN_ROUGHNESS, metalness: 0 }));
  water.rotation.x = -Math.PI / 2;
  world.add(water);
  pieces = new THREE.Group();
  world.add(pieces);
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
}

function fail(why) {
  if (failed) return;
  failed = why;
  console.warn("WGBG-3D", why);
  failHandler(why);
}

/** The model file [name] (models/<name>.glb), loaded once; null until it has arrived. */
function model(name) {
  if (!models.has(name)) {
    models.set(name, null);
    loader.load(`models/${name}.glb`, g => { models.set(name, g.scene); build(); render(); },
      undefined, e => fail(`${name}: ${e && e.message || e}`));
  }
  return models.get(name);
}

/** [m] as an item wants it: every material in [all], or the wood and sails in [wood] (the phone's liveTint); a shell's back faces. */
function material(m, it) {
  const colour = it.all || ((m.name === "WoodBody" || m.name === "SailCloth") ? it.wood : null);
  if (!colour && !it.back && !(it.alpha < 1)) return m;
  const key = `${m.uuid}|${colour}|${!!it.back}|${it.alpha ?? 1}|${it.metal || ""}`;
  if (!tints.has(key)) {
    const t = m.clone();
    if (colour) t.color = new THREE.Color(colour);
    if (it.metal && "metalness" in t) { t.metalness = it.metal[0]; t.roughness = it.metal[1]; }
    if (it.back) t.side = THREE.BackSide;
    if (it.alpha < 1) { t.transparent = true; t.opacity = it.alpha; }
    tints.set(key, t);
  }
  return tints.get(key);
}

/**
 * A number's face, painted as the phone paints its runtime number (LiveNumberGlb.kt): the numeral and its pips in [ink],
 * on a quad as wide as the plate, flat on it.
 */
function digit(n, ink) {
  const key = `${n}|${ink}`;
  if (!digits.has(key)) {
    const px = 256, c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d"), perUnit = px / (2 * face.r), text = String(n);
    g.fillStyle = ink;
    g.font = `bold ${face.text * perUnit}px sans-serif`;
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    const m = g.measureText(text);
    const ascent = m.fontBoundingBoxAscent || face.text * perUnit * 0.93, descent = m.fontBoundingBoxDescent || face.text * perUnit * 0.24;
    g.fillText(text, px / 2, px / 2 - face.raise * (ascent + descent) + ascent);
    const pips = 6 - Math.abs(7 - n), plate = face.r * perUnit;
    for (let i = 0; i < pips; i++) {
      g.beginPath(); g.arc(px / 2 + (i - (pips - 1) / 2) * 0.12 * plate, px / 2 + face.pipsDown * plate, 0.05 * plate, 0, 2 * Math.PI); g.fill();
    }
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
    const geometry = new THREE.PlaneGeometry(2 * face.r, 2 * face.r);
    geometry.rotateX(-Math.PI / 2);   // flat, its top toward -z as the phone's quad
    digits.set(key, new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false })));
  }
  return digits.get(key).clone();
}

/** Each item's object, made once its model has arrived; a slot stays empty meanwhile. */
function build() {
  items.forEach((it, i) => {
    const slot = pieces.children[i];
    if (!slot || slot.children.length) return;
    let obj;
    if (it.digit) obj = digit(it.digit, it.ink);
    else {
      const src = model(it.f);
      if (!src) return;
      obj = src.clone(true);
      obj.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => material(m, it)) : material(o.material, it); });
    }
    slot.add(obj);
  });
}

function render() {
  if (!lastPose || canvas.style.display === "none") return;
  const [left, top, width, height] = lastPose.box, [cx, cy, s, tilt, rot, w, h] = lastPose.cam;
  Object.assign(canvas.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  if (canvas.width !== Math.round(w) || canvas.height !== Math.round(h)) renderer.setSize(Math.round(w), Math.round(h), false);
  // The phone's camera (LiveBoardRenderer.updateCamera): orthographic, the eye up and toward the screen's bottom, turned by rot.
  const st = Math.sin(tilt), ct = Math.cos(tilt), sr = Math.sin(rot), cr = Math.cos(rot);
  camera.left = -cx / s; camera.right = (w - cx) / s; camera.top = cy / s; camera.bottom = -(h - cy) / s;
  camera.position.set(20 * st * sr, 20 * ct, 20 * st * cr);
  camera.up.set(-ct * sr, st, -ct * cr);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  const m = lastPose.m;
  pieces.children.forEach((slot, i) => { slot.matrix.fromArray(m, i * 16); slot.matrixWorldNeedsUpdate = true; });
  renderer.render(world, camera);
}

/** A light's colour as the page has always read one (sRGB, as a #RRGGBB would be). */
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

/** The theme's sky and lights and the sea's picture ([s].light, [s].ocean), set again only when they change. */
function look(s) {
  const key = JSON.stringify([s.light, s.ocean]);
  if (key === lit) return;
  lit = key;
  for (const l of lights) world.remove(l);
  lights = [];
  const [sr, sg, sb] = s.light.sky;
  world.background = new THREE.Color().setRGB(sr, sg, sb, THREE.LinearSRGBColorSpace);
  const [fr, fg, fb, gr, gg, gb, flux] = s.light.fill;
  lights.push(new THREE.HemisphereLight(srgb(fr, fg, fb), srgb(gr, gg, gb), flux * FILL_PER_LUX));
  for (const [x, y, z, r, g, b, lux] of s.light.lights) {
    const light = new THREE.DirectionalLight(srgb(r, g, b), lux * PER_LUX);
    light.position.set(-x * 10, -y * 10, -z * 10);   // a direction of travel: the light sits the other way
    lights.push(light);
  }
  for (const l of lights) world.add(l);
  const old = water.material.map;
  if (s.ocean.file) {
    const ocean = new THREE.TextureLoader().load(`${ART}${s.ocean.file}.webp`, () => render(), undefined,
      () => fail(`sea picture ${s.ocean.file} did not load`));
    ocean.wrapS = ocean.wrapT = THREE.RepeatWrapping;
    ocean.colorSpace = THREE.SRGBColorSpace;
    ocean.repeat.set(200 / s.ocean.tile, 200 / s.ocean.tile);
    water.material.map = ocean;
  } else water.material.map = null;
  water.material.needsUpdate = true;
  if (old) old.dispose();
}

/** A new scene: the items in the order their matrices come in each pose. */
export function scene(json) {
  if (!renderer) setup();
  const s = JSON.parse(json);
  items = s.items; face = s.face;
  look(s);
  water.position.y = s.sea;
  pieces.clear();
  for (let i = 0; i < items.length; i++) { const g = new THREE.Group(); g.matrixAutoUpdate = false; pieces.add(g); }
  build();
  canvas.style.display = "block";
  render();
}

/** The board's box on the page, the camera and every item's matrix. */
export function pose(json) {
  if (!renderer) return;
  lastPose = JSON.parse(json);
  canvas.style.display = "block";
  render();
}

/** The game screen left the 3D board (another board, or another screen): the canvas goes; the models stay loaded. */
export function hide() { if (canvas) canvas.style.display = "none"; lastPose = null; }

/** [f] runs when a model can't load: the game then goes back to the flat board, as the phone's does. */
export function onFail(f) { failHandler = f; failed = ""; }

/** For tests: how many models are still loading, the first failure, how many items have their object. */
export function status() {
  return { loading: [...models.values()].filter(m => m === null).length, failed, items: items.length,
    drawn: pieces ? pieces.children.filter(g => g.children.length).length : 0, shown: !!canvas && canvas.style.display !== "none" };
}
