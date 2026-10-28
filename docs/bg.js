// Background: slow-motion waves of the page's soft colours, like the old drifting blobs but flowing. Ribbons of colour
// are drawn on a small canvas, blurred and scaled up to fill the screen, which keeps them soft and cheap to draw.
// Decorative only: it is aria-hidden, draws one still frame under reduced motion or ?motion=off, and stops while the
// tab is hidden.
"use strict";

(() => {
  const cv = document.getElementById("bg3d"), ctx = cv.getContext("2d");
  if (!ctx) return;
  const root = document.documentElement;
  const still = () => root.classList.contains("no-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SCALE = 0.2;                   // draw at a fifth of the screen size; the blur hides it
  const BLUR = "filter" in ctx;        // canvas blur where supported, otherwise the upscaling alone softens the edges
  // each ribbon: colour token, height on screen (0 top, 1 bottom), wave height, thickness, waves across, speed, phase
  const RIBBONS = [
    ["--blob-a", 0.10, 0.10, 0.34, 0.9, 0.021, 0.0],   // speed in waves per second: about 45-60 s per wave
    ["--blob-c", 0.42, 0.12, 0.26, 1.2, -0.017, 2.1],
    ["--blob-b", 0.62, 0.11, 0.30, 0.8, 0.019, 4.2],
    ["--blob-a", 0.92, 0.09, 0.28, 1.1, -0.022, 1.3],
  ];
  let W = 0, H = 0, colours = [], alpha = 0.6;

  function rgba(hex, a) {
    const h = hex.replace("#", ""), n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function readColours() {
    const css = getComputedStyle(root);
    colours = RIBBONS.map(([token]) => css.getPropertyValue(token).trim() || "#8fb8f5");
    alpha = parseFloat(css.getPropertyValue("--wave-alpha")) || 0.6;
  }
  function resize() {
    W = Math.max(40, Math.round(window.innerWidth * SCALE));
    H = Math.max(40, Math.round(window.innerHeight * SCALE));
    cv.width = W; cv.height = H;
  }

  // a ribbon's edge: two sine waves added together, so the shape never quite repeats
  const edge = (x, t, waves, speed, phase, amp, base) =>
    H * (base + amp * Math.sin((x / W) * waves * Math.PI * 2 + t * speed * Math.PI * 2 + phase)
                + amp * 0.45 * Math.sin((x / W) * waves * 2.3 * Math.PI * 2 - t * speed * 1.7 * Math.PI * 2 + phase * 1.9));

  function draw(ms) {
    const t = ms / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.filter = BLUR ? `blur(${Math.round(Math.min(W, H) * 0.08)}px)` : "none";
    RIBBONS.forEach(([, base, amp, thick, waves, speed, phase], i) => {
      const step = Math.max(2, W / 60);
      ctx.beginPath();
      for (let x = -step; x <= W + step; x += step) ctx.lineTo(x, edge(x, t, waves, speed, phase, amp, base - thick / 2));
      for (let x = W + step; x >= -step; x -= step) ctx.lineTo(x, edge(x, t, waves * 0.8, speed * 0.7, phase + 1.4, amp * 0.8, base + thick / 2));
      ctx.closePath();
      // brightest along the middle of the ribbon, fading towards both edges
      const g = ctx.createLinearGradient(0, H * (base - thick / 2 - amp), 0, H * (base + thick / 2 + amp));
      g.addColorStop(0, rgba(colours[i], 0));
      g.addColorStop(0.5, rgba(colours[i], alpha));
      g.addColorStop(1, rgba(colours[i], 0));
      ctx.fillStyle = g;
      ctx.fill();
    });
    ctx.filter = "none";
  }

  let raf = 0;
  const loop = (ms) => { draw(ms); raf = requestAnimationFrame(loop); };
  function start() {
    cancelAnimationFrame(raf);
    if (still()) draw(0);
    else raf = requestAnimationFrame(loop);
  }

  readColours(); resize(); start();
  window.addEventListener("resize", () => { resize(); if (still()) draw(0); });
  document.addEventListener("visibilitychange", () => (document.hidden ? cancelAnimationFrame(raf) : start()));
  // follow theme changes: the toggle sets data-theme, the OS setting fires the media query
  const recolour = () => { readColours(); if (still()) draw(0); };
  new MutationObserver(recolour).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolour);
})();
