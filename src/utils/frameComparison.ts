export function compareFrames(prevCanvas: HTMLCanvasElement | null, currentCanvas: HTMLCanvasElement, threshold: number): boolean {
  if (!prevCanvas) return true;

  const w = 32;
  const h = 32;
  
  const sig1 = computeSignature(prevCanvas, w, h);
  const sig2 = computeSignature(currentCanvas, w, h);

  let sum = 0;
  for (let i = 0; i < sig1.length; i++) {
    sum += Math.abs(sig1[i] - sig2[i]);
  }
  
  // Maximum possible difference per pixel is 255.
  // diff is the average pixel grayscale difference (0..255).
  const diff = sum / sig1.length;
  
  // the hook uses a 0.02 threshold, which corresponds to 2% difference.
  // 2% difference on a 0-255 scale is 5.1
  const diffRatio = diff / 255.0;
  
  return diffRatio > threshold;
}

function computeSignature(canvas: HTMLCanvasElement, w: number, h: number) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;

  const ctx = tmp.getContext("2d", { willReadFrequently: true });
  if (!ctx) return new Uint8Array(w * h);

  ctx.drawImage(canvas, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const sig = new Uint8Array(w * h);

  // Grayscale signature
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sig[p] = (r * 30 + g * 59 + b * 11) / 100;
  }
  return sig;
}
