// Matrix Rain — canvas background. Falling katakana + digit columns with a
// bright lead char, mid-bright accent, dim trail. ~24fps cadence so it looks
// chunky/terminal-ish. Tinted with the active theme accent.

import { useEffect, useRef } from "react";

interface Props {
  enabled: boolean;
  density?: number;
  opacity?: number;
  accent?: string;
  /** Background tint used for the fade wash each frame. */
  fade?: string;
}

const CHARS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:・.\"=*+-<>¦|";

function hexWithAlpha(hex: string, alphaHex: string): string {
  // hex like #00ff95 → #00ff9526. If already has alpha, replace.
  if (hex.length === 7) return hex + alphaHex;
  if (hex.length === 9) return hex.slice(0, 7) + alphaHex;
  return hex;
}

export function MatrixRain({
  enabled,
  density = 16,
  opacity = 0.35,
  accent = "#00ff95",
  fade = "#0a0e0e",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const dropsRef = useRef<number[]>([]);
  const lastRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = Math.ceil(w / density);
      const prev = dropsRef.current;
      dropsRef.current = new Array(cols)
        .fill(0)
        .map((_, i) => (prev[i] != null ? prev[i] : Math.random() * -50));
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const tick = (t: number) => {
      const dt = t - lastRef.current;
      if (dt > 42) {
        lastRef.current = t;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        ctx.fillStyle = hexWithAlpha(fade, "26");
        ctx.fillRect(0, 0, w, h);
        ctx.font = `${density}px "JetBrains Mono", "Fira Code", monospace`;
        ctx.textBaseline = "top";

        const drops = dropsRef.current;
        for (let i = 0; i < drops.length; i++) {
          const ch = CHARS[(Math.random() * CHARS.length) | 0];
          const x = i * density;
          const y = drops[i] * density;

          ctx.fillStyle = "#d9ffe9";
          ctx.fillText(ch, x, y);
          ctx.fillStyle = accent;
          ctx.fillText(
            CHARS[(Math.random() * CHARS.length) | 0],
            x,
            y - density,
          );
          ctx.fillStyle = hexWithAlpha(accent, "59");
          ctx.fillText(
            CHARS[(Math.random() * CHARS.length) | 0],
            x,
            y - density * 3,
          );

          if (y > h && Math.random() > 0.975) drops[i] = 0;
          drops[i] += 1;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [enabled, density, accent, fade]);

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity,
        pointerEvents: "none",
        mixBlendMode: "screen",
      }}
    />
  );
}
