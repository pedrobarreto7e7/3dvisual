import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { CAR_VIEWS, type AppConfig, type ProviderId, type QualityPreset } from '../shared/types.ts';
import { JobManager, isJobId, sniffImageMime } from './jobs.ts';
import { DEMO_MODEL_PATH, createDemoProvider } from './providers/demo.ts';
import { createMeshyProvider } from './providers/meshy.ts';
import { createTripoProvider } from './providers/tripo.ts';
import type { InputImage, Provider } from './providers/types.ts';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = path.resolve(root, process.env.DATA_DIR ?? 'data');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const providers: Record<ProviderId, Provider> = {
  meshy: createMeshyProvider(process.env.MESHY_API_KEY?.trim() || undefined),
  tripo: createTripoProvider(
    process.env.TRIPO_API_KEY?.trim() || undefined,
    process.env.TRIPO_API_BASE?.trim() || undefined,
  ),
  demo: createDemoProvider(),
};

const jobs = new JobManager({ dataDir: DATA_DIR, providers });
await jobs.init();

const app = express();
app.disable('x-powered-by');

app.get('/api/config', (_req, res) => {
  const list = [providers.meshy, providers.tripo, providers.demo].map((p) => p.info);
  const config: AppConfig = {
    providers: list,
    defaultProvider: list.find((p) => p.configured && p.id !== 'demo')?.id ?? 'demo',
  };
  res.json(config);
});

app.get('/api/jobs', (_req, res) => {
  res.json(jobs.list());
});

app.get('/api/jobs/:id', (req, res) => {
  const job = isJobId(req.params.id) ? jobs.get(req.params.id) : undefined;
  if (!job) return void res.status(404).json({ error: 'Geração não encontrada.' });
  res.json(job);
});

app.delete('/api/jobs/:id', async (req, res) => {
  const ok = isJobId(req.params.id) && (await jobs.remove(req.params.id));
  if (!ok) return void res.status(404).json({ error: 'Geração não encontrada.' });
  res.status(204).end();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: CAR_VIEWS.length, fields: 10 },
}).fields(CAR_VIEWS.map((name) => ({ name, maxCount: 1 })));

app.post('/api/jobs', upload, async (req, res) => {
  const providerId = String(req.body?.provider ?? '') as ProviderId;
  const provider = providers[providerId];
  if (!provider) return void res.status(400).json({ error: 'Escolha um provedor válido.' });
  if (!provider.info.configured) {
    return void res.status(400).json({
      error: `${provider.info.name} não está configurado. Adicione a chave de API no arquivo .env e reinicie o servidor.`,
    });
  }
  const quality = String(req.body?.quality ?? '') as QualityPreset;
  if (!provider.info.qualities.some((q) => q.id === quality)) {
    return void res.status(400).json({ error: 'Qualidade inválida para este provedor.' });
  }

  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const images: InputImage[] = [];
  for (const view of CAR_VIEWS) {
    const file = files[view]?.[0];
    if (!file) continue;
    const mime = sniffImageMime(file.buffer);
    if (!mime) return void res.status(400).json({ error: `A foto "${view}" não é JPG, PNG ou WebP.` });
    images.push({ view, mime, data: file.buffer });
  }
  if (images.length === 0) return void res.status(400).json({ error: 'Envie pelo menos uma foto do carro.' });
  if (images.length > provider.info.maxImages) {
    return void res.status(400).json({ error: `${provider.info.name} aceita no máximo ${provider.info.maxImages} fotos.` });
  }
  if (images.length > 1 && provider.info.multiviewRequiresFront && !images.some((i) => i.view === 'front')) {
    return void res.status(400).json({ error: `Com várias fotos, ${provider.info.name} exige a foto da frente.` });
  }

  const job = await jobs.create({
    provider: providerId,
    quality,
    title: typeof req.body?.title === 'string' ? req.body.title : undefined,
    images,
  });
  res.status(201).json(job);
});

app.get('/api/demo-car.glb', (_req, res) => {
  res.type('model/gltf-binary').sendFile(DEMO_MODEL_PATH, { maxAge: '1d' });
});

app.use(
  '/api/files',
  express.static(jobs.filesDir, {
    fallthrough: false,
    index: false,
    dotfiles: 'deny',
    maxAge: '1d',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.glb')) res.setHeader('Content-Type', 'model/gltf-binary');
    },
  }),
);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

// Em produção o próprio servidor entrega o frontend compilado (npm run build).
const distDir = path.join(root, 'dist');
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
if (production && existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: '7d' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Cada foto pode ter no máximo 15 MB.'
        : err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Campo de foto inesperado.'
          : `Upload inválido (${err.code}).`;
    return void res.status(400).json({ error: message });
  }
  const status = Number(err?.status ?? err?.statusCode ?? 500);
  if (status >= 500) console.error(err);
  const message = status === 404 ? 'Arquivo não encontrado.' : status < 500 ? 'Requisição inválida.' : 'Erro interno do servidor.';
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, () => {
  const configured = Object.values(providers)
    .filter((p) => p.info.configured && p.info.id !== 'demo')
    .map((p) => p.info.name);
  console.log(`API do 3DVisual em http://localhost:${PORT}`);
  console.log(
    configured.length
      ? `Provedores de IA ativos: ${configured.join(', ')}`
      : 'Nenhuma chave de IA configurada — apenas o modo demonstração está disponível (veja .env.example).',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await jobs.flush().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
