// The 3D board (the app's live board, LiveBoardMath.kt / LiveBoardView.kt): the same tiles, numbers, roads, buildings
// and Bandit as the flat board, drawn with three.js from the app's own GLB models (served next to the page in models/).
// The page's SVG board stays on top of it, squashed to the same tilt, and keeps everything you tap (corners, paths,
// tiles for the Bandit), so a tap lands where it does on the flat board. Orthographic, as the app's camera: a point on
// the tile tops (height 0) is on screen exactly where the squashed SVG puts it.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const S3 = Math.sqrt(3) / 2;
// The app's numbers (LiveBoardMath.kt, MainActivity.kt).
const LIVE_SEA = -0.24;                    // the sea under the tile tops
const LIVE_PLATE = [0.36, 0.45];           // the number plate, lower right of its tile
const NUMBER_TOKEN_R = 0.27, NUMBER_TEXT = 0.46, NUMBER_TEXT_RAISE = 0.56, NUMBER_PIPS_DOWN = 0.72;
const BUILDING_SCALE = 1.8, ROAD_SCALE = 0.8;
const LIVE_ROAD_LIFT = 0.035, LIVE_ROAD_HEIGHT = 2.5, LIVE_ROAD_HALF = 0.33 * ROAD_SCALE, LIVE_ROAD_GAP = 0.20;
const LIVE_PIECE_VIEW = 0.17453292;        // standing pieces are seen from 10 degrees above the table
const PIECE_BIAS = 2.5, NUMBER_BIAS = 3.5, STANDING_BIAS = 4.5;
const TERRAIN = ["timber", "clay", "fleece", "grain", "stone", "desert"];
const NUMBER_INK = "#2b2118", NUMBER_RED = "#b3261e";

const standing = m => m === "bandit" || m.endsWith("_homestead") || m.endsWith("_town");
const isNumber = m => m === "number_plate" || m.startsWith("digit_");
const biasOf = m => standing(m) ? STANDING_BIAS : isNumber(m) ? NUMBER_BIAS : m.includes("_road_") ? PIECE_BIAS : 0;
/** How far standing pieces lie back from the camera at board [tilt] (the app's liveLift). */
const liftOf = tilt => Math.max(0, Math.PI / 2 - LIVE_PIECE_VIEW - tilt);

/** The app's liveModelMatrix: column-major, heading about Y, a [lift] about the camera's right axis. */
function modelMatrix(p, lift = 0, rotation = 0) {
  const c = Math.cos(p.heading) * p.scale, s = Math.sin(p.heading) * p.scale;
  const h = [c, 0, -s, 0, p.scale * p.stretch, 0, s, 0, c];
  if (!lift) return [h[0], h[1], h[2], 0, h[3], h[4], h[5], 0, h[6], h[7], h[8], 0, p.x, p.height, p.z, 1];
  const ax = Math.cos(rotation), az = -Math.sin(rotation), ct = Math.cos(lift), st = Math.sin(lift), k = 1 - ct;
  const r = [ct + ax * ax * k, az * st, ax * az * k, -az * st, ct, ax * st, ax * az * k, -ax * st, ct + az * az * k];
  const m = [];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) {
    let sum = 0;
    for (let i = 0; i < 3; i++) sum += r[i * 3 + row] * h[col * 3 + i];
    m[col * 3 + row] = sum;
  }
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, p.x, p.height, p.z, 1];
}

/** A number's face: the flat board's numeral and pips, as the app's runtime number texture (LiveNumberGlb.kt). */
function numberTexture(n) {
  const px = 256, c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d"), perUnit = px / (2 * NUMBER_TOKEN_R), colour = n === 6 || n === 8 ? NUMBER_RED : NUMBER_INK;
  g.fillStyle = colour;
  g.font = `bold ${NUMBER_TEXT * perUnit}px sans-serif`;
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  const m = g.measureText(String(n));
  const ascent = m.fontBoundingBoxAscent || NUMBER_TEXT * perUnit * 0.93, descent = m.fontBoundingBoxDescent || NUMBER_TEXT * perUnit * 0.24;
  g.fillText(String(n), px / 2, px / 2 - NUMBER_TEXT_RAISE * (ascent + descent) + ascent);
  const pips = 6 - Math.abs(7 - n), plate = NUMBER_TOKEN_R * perUnit;
  for (let i = 0; i < pips; i++) {
    g.beginPath(); g.arc(px / 2 + (i - (pips - 1) / 2) * 0.12 * plate, px / 2 + NUMBER_PIPS_DOWN * plate, 0.05 * plate, 0, 2 * Math.PI); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/**
 * Makes the 3D board in [wrap] under the page's [svg]. [onReady] runs whenever a model arrives, so the page can draw
 * again; [onFail] when one can't load (offline, say). Gives { draw(board, st, colourOf), tilt, canvas, project(x, h, z),
 * status(), dispose() }.
 */
export function createBoard3d(wrap, svg, { tilt = 0.4, onReady = () => {}, onFail = () => {} } = {}) {
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
  const sea = getComputedStyle(wrap).backgroundColor || "#2c6f8f";
  scene.background = new THREE.Color(sea);
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a4a55, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-4, 10, 3);
  scene.add(sun);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: sea, roughness: 0.35, metalness: 0 }));
  water.rotation.x = -Math.PI / 2; water.position.y = LIVE_SEA;
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
  function digit(n) {
    if (!digits.has(n)) {
      const g = new THREE.PlaneGeometry(2 * NUMBER_TOKEN_R, 2 * NUMBER_TOKEN_R);
      g.rotateX(-Math.PI / 2);   // flat on the plate, its top toward the top of the screen (-z)
      digits.set(n, new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: numberTexture(n), transparent: true, depthWrite: false, toneMapped: false })));
    }
    return digits.get(n);
  }

  let tiltNow = tilt, last = null;
  /** The placements of the app's livePlacements for this board and state (base game; default theme). */
  function placements(board, st, colourOf) {
    const out = [];
    const add = (model, x, z, more = {}) => out.push(Object.assign({ model, x, z, height: 0, scale: 1, heading: 0, stretch: 1, colour: null }, more));
    const vx = v => [board.vertices[v][0] * S3, board.vertices[v][1] * 0.5];
    const hexAt = h => { const ps = board.hexes[h].v.map(vx); return [ps.reduce((s, p) => s + p[0], 0) / 6, ps.reduce((s, p) => s + p[1], 0) / 6]; };
    // The coast: a stone-and-grass edge piece along every edge with land on one side only (liveCoastPlacements).
    const hexesOf = new Map();
    board.hexes.forEach((h, i) => h.v.forEach(v => { if (!hexesOf.has(v)) hexesOf.set(v, []); hexesOf.get(v).push(i); }));
    board.edges.forEach(([v1, v2]) => {
      const shared = (hexesOf.get(v1) || []).filter(h => (hexesOf.get(v2) || []).includes(h));
      if (shared.length !== 1) return;
      const a = vx(v1), b = vx(v2), c = hexAt(shared[0]), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const dx = mx - c[0], dz = mz - c[1], len = Math.hypot(dx, dz) || 1;
      add("coast_a", mx, mz, { heading: Math.atan2(dx / len, dz / len) });
    });
    board.hexes.forEach((h, i) => {
      const [x, z] = hexAt(i);
      add(`tile_${TERRAIN[h.res] || "desert"}_lod1`, x, z);
      // Age of Chivalry's own numbers: the Tinkerer swaps them (the flat board shows the same).
      const num = st.ck ? st.ck.numbers[i] : h.num;
      if (num > 0) {
        add("number_plate", x + LIVE_PLATE[0], z + LIVE_PLATE[1], { height: 0.012 });
        if (i !== st.robber) add(`digit_${num}`, x + LIVE_PLATE[0], z + LIVE_PLATE[1], { height: 0.039 });
      }
    });
    if (st.robber >= 0) { const [x, z] = hexAt(st.robber); add("bandit", x + LIVE_PLATE[0], z + LIVE_PLATE[1], { height: 0.012 }); }
    board.edges.forEach(([v1, v2], e) => {
      const owner = st.road[e];
      if (owner < 0) return;
      const a = vx(v1), b = vx(v2), len = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
      const spread = Math.max(0, len / 2 - LIVE_ROAD_GAP - LIVE_ROAD_HALF);
      for (const side of [-1, 1]) add("default_road_v", (a[0] + b[0]) / 2 + dx * side * spread, (a[1] + b[1]) / 2 + dz * side * spread,
        { height: LIVE_ROAD_LIFT, scale: ROAD_SCALE, heading: Math.atan2(dx, dz), stretch: LIVE_ROAD_HEIGHT, colour: colourOf(owner) });
    });
    st.owner.forEach((owner, v) => {
      if (owner < 0) return;
      const [x, z] = vx(v);
      add(st.building[v] === 2 ? "default_town" : "default_homestead", x, z, { scale: BUILDING_SCALE, colour: colourOf(owner) });
    });
    return out;
  }

  function place(p) {
    let obj;
    if (p.model.startsWith("digit_")) obj = digit(+p.model.slice(6)).clone();
    else {
      const src = model(p.model);
      if (!src) return null;
      obj = src.clone(true);
      if (p.colour) obj.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(m => tint(m, p.colour)) : tint(o.material, p.colour); });
    }
    const lift = standing(p.model) ? liftOf(tiltNow) : 0;
    // Standing pieces lean back (the app's liveStandingMatrix, unrotated): seen from 10 degrees above the table.
    const m = modelMatrix(p, -lift, 0);
    // Pieces slide toward the camera (no change on screen, orthographic) so the terrain never hides them (#95).
    const d = biasOf(p.model);
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

  function draw(board, st, colourOf) {
    last = { board, st, colourOf };
    pieces.clear();
    for (const p of placements(board, st, colourOf)) { const o = place(p); if (o) pieces.add(o); }
    if (frame()) renderer.render(scene, camera);
  }
  const resize = () => { if (last && frame()) renderer.render(scene, camera); };
  const observer = new ResizeObserver(resize);
  observer.observe(wrap);

  return {
    draw,
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
