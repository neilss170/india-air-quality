// Background: a slowly turning 3D field of particles, like the PM2.5 (many, small) and PM10 (fewer, larger, dust-
// coloured) that the dashboard measures. Plain canvas with a perspective projection, no library. Decorative only:
// it is aria-hidden, draws one still frame under reduced motion or ?motion=off, and stops while the tab is hidden.
"use strict";

(() => {
  const cv = document.getElementById("bg3d"), ctx = cv.getContext("2d");
  if (!ctx) return;
  const root = document.documentElement;
  const still = () => root.classList.contains("no-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CAM = 2.6; // camera distance from the centre of the field, in field units

  // seeded random numbers, so the still frame (reduced motion, screenshots) is the same every time
  let seed = 7;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const wrap = (v) => ((((v + 1) % 2) + 2) % 2) - 1; // keep a coordinate inside [-1, 1)

  let W = 0, H = 0, dpr = 1, focal = 1, ax = 1, ay = 1, pts = [], fine, coarse, alpha = 0.6;
  const view = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0 };

  function rgba(hex, a) {
    const h = hex.replace("#", ""), n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // a soft round dot, drawn once per colour and scaled per particle
  function sprite(hex) {
    const c = document.createElement("canvas"), n = 64, g = c.getContext("2d");
    c.width = c.height = n;
    const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grd.addColorStop(0, rgba(hex, 1)); grd.addColorStop(0.28, rgba(hex, 0.85)); grd.addColorStop(1, rgba(hex, 0));
    g.fillStyle = grd; g.fillRect(0, 0, n, n);
    return c;
  }
  function colours() {
    const css = getComputedStyle(root);
    fine = sprite(css.getPropertyValue("--particle-fine").trim() || "#2f5d9e");
    coarse = sprite(css.getPropertyValue("--particle-coarse").trim() || "#c07a3a");
    alpha = parseFloat(css.getPropertyValue("--particle-alpha")) || 0.6;
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    focal = Math.min(W, H) * 0.9;
    // stretch the field so it overfills the screen at the centre depth, whatever the aspect ratio
    ax = ((W / 2) * CAM / focal) * 1.25; ay = ((H / 2) * CAM / focal) * 1.25;
    seed = 7;
    const n = Math.round(Math.min(460, Math.max(160, (W * H) / 3400)));
    pts = Array.from({ length: n }, (_, i) => {
      const big = i % 5 === 0; // about one in five is coarse dust
      return { x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1, r: big ? 3 + rnd() * 4.5 : 1 + rnd() * 1.6, big, ph: rnd() * 6.28 };
    });
  }

  function draw(ms) {
    const t = ms / 1000;
    view.yaw += (view.tYaw - view.yaw) * 0.04;
    view.pitch += (view.tPitch - view.pitch) * 0.04;
    const spin = t * 0.025 + view.yaw, cy = Math.cos(spin), sy = Math.sin(spin), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const scrolled = window.scrollY / Math.max(1, document.documentElement.scrollHeight - H); // 0 at the top, 1 at the bottom
    const list = [];
    for (const p of pts) {
      // a light wind to the right, a slow rise, a little wobble; the camera moves up through the field as you scroll
      const fx = wrap(p.x + t * 0.012), fy = wrap(p.y - t * 0.006 + scrolled * 0.9);
      const x = fx * ax, y = fy * ay + 0.04 * Math.sin(t * 0.4 + p.ph), z = p.z;
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy;          // turn around the vertical axis
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;         // then tilt
      const depth = z2 + CAM;
      if (depth < 0.4) continue;
      const k = focal / depth;
      // fade with distance (fog), and near the edges of the field so wrapped particles never pop in
      const edge = Math.min(1, (1 - Math.abs(fx)) * 8, (1 - Math.abs(fy)) * 8);
      const a = Math.max(0, Math.min(1, 1.35 - (depth - 1.6) * 0.45)) * edge * alpha;
      // size grows faster than linearly up close, like out-of-focus dust right in front of the lens
      if (a > 0.01) list.push([depth, W / 2 + x1 * k, H / 2 + y2 * k, p.r * (CAM / depth) ** 1.6, p.big, a]);
    }
    list.sort((a, b) => b[0] - a[0]); // far first
    ctx.clearRect(0, 0, W, H);
    for (const [, x, y, s, big, a] of list) {
      ctx.globalAlpha = a;
      ctx.drawImage(big ? coarse : fine, x - s * 2, y - s * 2, s * 4, s * 4);
    }
    ctx.globalAlpha = 1;
  }

  let raf = 0;
  const loop = (ms) => { draw(ms); raf = requestAnimationFrame(loop); };
  function start() {
    cancelAnimationFrame(raf);
    if (still()) { view.yaw = view.tYaw; view.pitch = view.tPitch; draw(0); }
    else raf = requestAnimationFrame(loop);
  }

  colours(); resize(); start();
  window.addEventListener("resize", () => { resize(); if (still()) draw(0); });
  window.addEventListener("pointermove", (e) => {
    view.tYaw = (e.clientX / W - 0.5) * 0.5;
    view.tPitch = (e.clientY / H - 0.5) * 0.3;
  }, { passive: true });
  window.addEventListener("scroll", () => { if (still()) draw(0); }, { passive: true });
  document.addEventListener("visibilitychange", () => (document.hidden ? cancelAnimationFrame(raf) : start()));
  // follow theme changes: the toggle sets data-theme, the OS setting fires the media query
  const recolour = () => { colours(); if (still()) draw(0); };
  new MutationObserver(recolour).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolour);
})();
