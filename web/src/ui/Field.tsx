import { useEffect, useRef } from "react";

/// The ambient field behind the landing page.
///
/// Written against a bare 2D canvas rather than a library. The CSP is
/// `script-src 'self'` and `check-origins.mjs` refuses third-party origins, so
/// anything from a CDN would be blocked at runtime; bundling three.js would
/// put ~600 KB into an artefact whose SRI digest is a published attestation.
/// This is a few hundred bytes and needs neither.
///
/// What it draws: points that drift, briefly find each other, and let go.
/// Links form on proximity and fade with distance, so the structure is always
/// dissolving. That is the product — a room is a thing that holds together for
/// a while and then does not.
const DENSITY = 1 / 18000; // points per px², so a phone gets fewer
const MAX_POINTS = 90;
const LINK_DIST = 130;
const POINTER_PULL = 90;

/// Uniform floats in [0,1) from the CSPRNG. Nothing here is security
/// relevant, but the lint rule that forbids Math.random is blanket by design —
/// an exception costs a future reader a judgement call, and drawing from
/// crypto costs one array.
function randomUnitFloats(n: number): Float64Array {
  const raw = new Uint32Array(n);
  crypto.getRandomValues(raw);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = raw[i] / 4294967296;
  return out;
}

interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function Field() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let points: Point[] = [];
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const pointer = { x: -9999, y: -9999 };

    // Colours come from the stylesheet so the field cannot drift out of step
    // with the temper accent.
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#7fa8c9";

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const want = Math.min(MAX_POINTS, Math.round(w * h * DENSITY));
      const r = randomUnitFloats(want * 4);
      points = Array.from({ length: want }, (_, i) => ({
        x: r[i * 4] * w,
        y: r[i * 4 + 1] * h,
        vx: (r[i * 4 + 2] - 0.5) * 0.16,
        vy: (r[i * 4 + 3] - 0.5) * 0.16,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);

      for (const p of points) {
        p.x += p.vx;
        p.y += p.vy;
        // Wrap rather than bounce: a bounce reads as a wall, and there is no
        // wall here.
        if (p.x < -20) p.x = w + 20;
        if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20;
        if (p.y > h + 20) p.y = -20;

        const dx = pointer.x - p.x;
        const dy = pointer.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < POINTER_PULL && d > 0.1) {
          const pull = (1 - d / POINTER_PULL) * 0.012;
          p.vx += (dx / d) * pull;
          p.vy += (dy / d) * pull;
        }
        // Friction, or the pointer would wind them up indefinitely.
        p.vx *= 0.994;
        p.vy *= 0.994;
      }

      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const a = points[i];
          const b = points[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > LINK_DIST) continue;
          ctx.globalAlpha = (1 - d / LINK_DIST) * 0.16;
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 0.5;
      ctx.fillStyle = accent;
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(draw);
    };

    const onPointer = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
    };
    // A hidden tab should not be burning a phone battery on decoration.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf && !reduced) {
        raf = requestAnimationFrame(draw);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);

    if (reduced) {
      // Still draw one frame: the texture is part of the page, the motion is
      // the part somebody asked us not to do.
      draw();
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      raf = requestAnimationFrame(draw);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="ambient-field" aria-hidden="true" />;
}
