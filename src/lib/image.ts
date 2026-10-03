export interface PreparedPhoto {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  name: string;
  /** Avisos de qualidade da foto (pt-BR). */
  warnings: string[];
}

/** Lado máximo enviado à IA: mais que isso só aumenta o upload, não a qualidade. */
const MAX_SIDE = 2048;
const MIN_RECOMMENDED = 768;

/**
 * Normaliza a foto no navegador: aplica a rotação EXIF, reduz para no máximo
 * 2048 px e recomprime (JPEG, ou PNG quando a foto já tem fundo transparente).
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (file.size > 40 * 1024 * 1024) throw new Error('Foto muito grande (máx. 40 MB).');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`Não foi possível ler "${file.name}". Use JPG, PNG ou WebP.`);
  }

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const keepAlpha = file.type === 'image/png' && hasTransparency(ctx, width, height);
  const type = keepAlpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao processar a foto.'))), type, 0.92),
  );

  const warnings: string[] = [];
  if (Math.max(width, height) < MIN_RECOMMENDED) {
    warnings.push('Resolução baixa: fotos com 1024 px ou mais geram texturas melhores.');
  }
  if (estimateBlur(ctx, width, height) < 6) {
    warnings.push('A foto parece desfocada; isso reduz o detalhe do modelo.');
  }

  return { blob, url: URL.createObjectURL(blob), width, height, name: file.name, warnings };
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < data.length; i += 4 * 16) if (data[i] < 250) return true;
  return false;
}

/** Variância do Laplaciano numa versão reduzida da foto: valores baixos indicam desfoque. */
function estimateBlur(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const s = Math.min(1, 256 / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * s));
  const sh = Math.max(8, Math.round(h * s));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d')!;
  sctx.drawImage(ctx.canvas, 0, 0, sw, sh);
  const { data } = sctx.getImageData(0, 0, sw, sh);
  const gray = new Float32Array(sw * sh);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - sw] + gray[i + sw] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return Math.sqrt(sumSq / n - mean * mean);
}
