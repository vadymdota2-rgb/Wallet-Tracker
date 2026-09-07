/**
 * Фон: сетка, узлы и связи между ними — как в прежнем приложении.
 *
 * Рисуем на canvas, а не в SVG: узлов немного, но они двигаются каждый кадр,
 * и перекладывать DOM ради этого незачем. При `prefers-reduced-motion`
 * остаётся один статичный кадр.
 */
import { useEffect, useRef } from "react";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const COUNT = 26;
const LINK = 132;
const GRID = 46;

export function Background() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let nodes: Node[] = [];

    const seed = () => {
      nodes = Array.from({ length: COUNT }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: Math.random() < 0.3 ? 3.2 : 1.6,
      }));
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);

      // Сетка — самый дальний слой.
      ctx.strokeStyle = "rgba(30,155,255,0.045)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += GRID) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = 0; y <= h; y += GRID) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();

      // Связи: чем ближе узлы, тем ярче нить.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d > LINK) continue;
          ctx.strokeStyle = `rgba(127,216,255,${(1 - d / LINK) * 0.16})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // Сами узлы: квадраты покрупнее и точки помельче.
      for (const n of nodes) {
        ctx.fillStyle = "rgba(127,216,255,0.30)";
        if (n.r > 2) ctx.strokeRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
        else {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    let raf = 0;
    let last = 0;
    const step = (t: number) => {
      raf = requestAnimationFrame(step);
      // 30 кадров в секунду: фон не должен греть телефон.
      if (t - last < 33) return;
      last = t;
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
      }
      draw();
    };

    resize();
    draw();
    if (!still) raf = requestAnimationFrame(step);

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(cv);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="bg-net" aria-hidden="true" />;
}
