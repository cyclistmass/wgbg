"use strict";
// The page's `flat-shapes` renderer (#300, docs/design/board-module-spec.md): draws the shapes the shared FlatScene
// (Kotlin, :game) builds from the board module and the game, in the SVG's own units (hex units). It knows no colour,
// size or board name: those are the module's (tools/deps_rules.txt checks). Text takes the page's own sans face.
const FLAT_NS = "http://www.w3.org/2000/svg";
let flatGradients = 0;

/**
 * Draws [shapes] (wgbg.scene) into the SVG group [parent]; [layers] picks which (a test on each shape's layer), and
 * [wrap] takes the water's colour as its background.
 */
function drawFlatScene(parent, shapes, wrap, layers = () => true) {
  const add = (tag, attrs) => {
    const e = document.createElementNS(FLAT_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  };
  const fill = f => ({ fill: f.c, "fill-opacity": f.a });
  const line = f => ({ fill: "none", stroke: f.c, "stroke-opacity": f.a, "stroke-width": f.w });
  for (const f of shapes) {
    if (!layers(f.layer)) continue;
    const p = f.p;
    switch (f.k) {
      case "fill":
        if (wrap) wrap.style.background = f.c;
        break;
      case "circle": {
        let paint = f.w ? line(f) : fill(f);
        if (f.c2) {
          // A vertical gradient from the top of the circle to its bottom.
          const id = `flatg${++flatGradients}`, defs = add("defs", {});
          const g = document.createElementNS(FLAT_NS, "linearGradient");
          for (const [k, v] of Object.entries({ id, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: p[1] - f.size, y2: p[1] + f.size })) g.setAttribute(k, v);
          for (const [offset, c, a] of [[0, f.c, f.a], [1, f.c2, f.a2]]) {
            const s = document.createElementNS(FLAT_NS, "stop");
            s.setAttribute("offset", offset); s.setAttribute("stop-color", c); s.setAttribute("stop-opacity", a);
            g.appendChild(s);
          }
          defs.appendChild(g);
          paint = { fill: `url(#${id})` };
        }
        add("circle", { cx: p[0], cy: p[1], r: f.size, ...paint });
        break;
      }
      case "polygon": {
        const pts = [];
        for (let i = 0; i < p.length; i += 2) pts.push(`${p[i]},${p[i + 1]}`);
        add("polygon", { points: pts.join(" "), ...(f.w ? { ...line(f), "stroke-linejoin": f.round ? "round" : "miter" } : fill(f)) });
        break;
      }
      case "line":
        add("line", { x1: p[0], y1: p[1], x2: p[2], y2: p[3], ...line(f), "stroke-linecap": f.round ? "round" : "butt" });
        break;
      case "rect":
        add("rect", { x: p[0], y: p[1], width: p[2], height: p[3], ...(f.w ? line(f) : fill(f)) });
        break;
      case "text": {
        const t = add("text", { x: p[0], y: p[1], "text-anchor": "middle", "dominant-baseline": "central", "font-size": f.size,
          "font-weight": f.bold ? 700 : 400, ...fill(f) });
        t.textContent = f.text;
        break;
      }
    }
  }
}
