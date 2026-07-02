import { useRef, useEffect } from "react";

export default function Waveform({ analyserGetter, label, color = "#4ade80" }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    function draw() {
      rafRef.current = requestAnimationFrame(draw);
      const data = analyserGetter?.();
      const w = canvas.width;
      const h = canvas.height;

      ctx.fillStyle = "#1e1e2e";
      ctx.fillRect(0, 0, w, h);

      if (!data) {
        // Flat line
        ctx.strokeStyle = "#444";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
        return;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();

      const sliceWidth = w / data.length;
      let x = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyserGetter, color]);

  return (
    <div className="waveform">
      <span className="waveform-label">{label}</span>
      <canvas ref={canvasRef} width={320} height={64} />
    </div>
  );
}
