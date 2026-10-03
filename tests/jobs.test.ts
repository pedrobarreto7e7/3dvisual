import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, ProviderId } from '../shared/types.ts';
import { JobManager, sniffImageMime } from '../server/jobs.ts';
import { ProviderError, type Provider, type ProviderPoll } from '../server/providers/types.ts';

const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const image = { view: 'front' as const, mime: 'image/jpeg' as const, data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) };

function fakeProvider(polls: (ProviderPoll | Error)[], download: (url: string) => Buffer = () => GLB): Provider & { starts: number } {
  const p = {
    starts: 0,
    info: {
      id: 'meshy' as ProviderId,
      name: 'Fake',
      description: '',
      configured: true,
      maxImages: 4,
      multiviewRequiresFront: false,
      qualities: [{ id: 'ultra' as const, label: '', hint: '' }],
    },
    pollIntervalMs: 1,
    async start() {
      p.starts++;
      return { taskId: 'task-1', mode: 'single' };
    },
    async poll() {
      const next = polls.shift();
      if (!next) throw new Error('sem mais respostas');
      if (next instanceof Error) throw next;
      return next;
    },
    async download(url: string) {
      return download(url);
    },
  };
  return p;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), '3dvisual-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manager(provider: Provider) {
  return new JobManager({
    dataDir: dir,
    providers: { meshy: provider, tripo: provider, demo: provider },
    sleep: async () => {},
    log: () => {},
  });
}

async function settle(jobs: JobManager, id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = jobs.get(id)!;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('a geração não terminou');
}

describe('JobManager', () => {
  it('gera, baixa o GLB e a miniatura, e persiste o histórico', async () => {
    const provider = fakeProvider(
      [
        { status: 'pending', progress: 0, stage: 'fila' },
        { status: 'running', progress: 55, stage: 'geometria' },
        { status: 'succeeded', progress: 100, modelUrl: 'https://x/m.glb', thumbnailUrl: 'https://x/t.png', credits: 30 },
      ],
      (url) => (url.endsWith('.png') ? PNG : GLB),
    );
    const jobs = manager(provider);
    await jobs.init();
    const created = await jobs.create({ provider: 'meshy', quality: 'ultra', title: ' Fusca azul ', images: [image] });
    expect(created.images).toEqual([{ view: 'front', url: `/api/files/${created.id}/front.jpg` }]);

    const job = await settle(jobs, created.id);
    expect(job).toMatchObject({
      status: 'succeeded',
      progress: 100,
      title: 'Fusca azul',
      credits: 30,
      modelUrl: `/api/files/${job.id}/model.glb`,
      thumbnailUrl: `/api/files/${job.id}/thumbnail.png`,
    });
    expect((await readFile(path.join(dir, 'jobs', job.id, 'model.glb'))).equals(GLB)).toBe(true);

    await jobs.flush();
    const saved = JSON.parse(await readFile(path.join(dir, 'jobs.json'), 'utf8'));
    expect(saved[0].id).toBe(job.id);
  });

  it('tolera falhas transitórias no polling', async () => {
    const provider = fakeProvider([
      new ProviderError('rede', { retryable: true }),
      new ProviderError('rede', { retryable: true }),
      { status: 'succeeded', progress: 100, modelUrl: 'https://x/m.glb' },
    ]);
    const jobs = manager(provider);
    const job = await settle(jobs, (await jobs.create({ provider: 'meshy', quality: 'ultra', images: [image] })).id);
    expect(job.status).toBe('succeeded');
  });

  it('marca falha com a mensagem do provedor', async () => {
    const provider = fakeProvider([{ status: 'failed', progress: 10, error: 'Meshy: imagem inválida' }]);
    const jobs = manager(provider);
    const job = await settle(jobs, (await jobs.create({ provider: 'meshy', quality: 'ultra', images: [image] })).id);
    expect(job).toMatchObject({ status: 'failed', error: 'Meshy: imagem inválida' });
  });

  it('rejeita arquivos que não são GLB', async () => {
    const provider = fakeProvider([{ status: 'succeeded', progress: 100, modelUrl: 'https://x/m.glb' }], () =>
      Buffer.from('<html>expired</html>'),
    );
    const jobs = manager(provider);
    const job = await settle(jobs, (await jobs.create({ provider: 'meshy', quality: 'ultra', images: [image] })).id);
    expect(job).toMatchObject({ status: 'failed', error: 'O provedor devolveu um arquivo que não é GLB.' });
  });

  it('retoma o polling após reiniciar, sem criar outra tarefa paga', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const queuedId = '22222222-2222-4222-8222-222222222222';
    const base = { provider: 'meshy', quality: 'ultra', title: 'x', progress: 40, stage: '…', images: [] };
    const now = new Date().toISOString();
    await mkdir(path.join(dir, 'jobs', id), { recursive: true });
    await writeFile(
      path.join(dir, 'jobs.json'),
      JSON.stringify([
        { ...base, id, status: 'processing', providerTaskId: 'task-9', providerMode: 'single', createdAt: now, updatedAt: now },
        { ...base, id: queuedId, status: 'queued', createdAt: now, updatedAt: now },
      ]),
    );

    const provider = fakeProvider([{ status: 'succeeded', progress: 100, modelUrl: 'https://x/m.glb' }]);
    const jobs = manager(provider);
    await jobs.init();
    expect((await settle(jobs, id)).status).toBe('succeeded');
    expect(provider.starts).toBe(0);
    // Sem ID de tarefa não há o que retomar: as fotos não chegaram ao provedor.
    expect(await settle(jobs, queuedId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/reiniciou/) });
  });

  it('apaga a geração e os arquivos', async () => {
    const jobs = manager(fakeProvider([{ status: 'succeeded', progress: 100, modelUrl: 'https://x/m.glb' }]));
    const job = await settle(jobs, (await jobs.create({ provider: 'meshy', quality: 'ultra', images: [image] })).id);
    expect(await jobs.remove(job.id)).toBe(true);
    expect(jobs.get(job.id)).toBeUndefined();
    await expect(stat(path.join(dir, 'jobs', job.id))).rejects.toThrow();
  });
});

describe('sniffImageMime', () => {
  it('reconhece JPEG, PNG e WebP pelo conteúdo', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('GIF89a-------'))).toBeNull();
  });
});
