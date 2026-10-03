import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Job, ProviderId, QualityPreset } from '../shared/types.ts';
import { ProviderError, type InputImage, type Provider, type ProviderPoll } from './providers/types.ts';

export interface JobManagerOptions {
  dataDir: string;
  providers: Record<ProviderId, Provider>;
  /** Tempo máximo de uma geração antes de desistir. */
  timeoutMs?: number;
  /** Falhas transitórias seguidas toleradas durante o polling. */
  maxPollFailures?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const ID_RE = /^[0-9a-f-]{36}$/;
export const isJobId = (id: string) => ID_RE.test(id);

export function sniffImageMime(buf: Buffer): InputImage['mime'] | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

const EXT: Record<InputImage['mime'], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function errorMessage(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  if (err instanceof Error) return `Erro inesperado: ${err.message}`;
  return 'Erro inesperado.';
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly opts: Required<JobManagerOptions>;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(options: JobManagerOptions) {
    this.opts = {
      timeoutMs: 30 * 60_000,
      maxPollFailures: 8,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (m) => console.log(m),
      ...options,
    };
  }

  get filesDir() {
    return path.join(this.opts.dataDir, 'jobs');
  }

  private get indexFile() {
    return path.join(this.opts.dataDir, 'jobs.json');
  }

  jobDir(id: string) {
    return path.join(this.filesDir, id);
  }

  /** Carrega o histórico e retoma gerações que estavam em andamento. */
  async init() {
    await mkdir(this.filesDir, { recursive: true });
    let saved: Job[] = [];
    try {
      saved = JSON.parse(await readFile(this.indexFile, 'utf8'));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') this.opts.log(`Aviso: não foi possível ler ${this.indexFile}: ${err?.message}`);
    }
    for (const job of saved) {
      if (!job?.id || !isJobId(job.id)) continue;
      this.jobs.set(job.id, job);
      if (job.status === 'queued' || job.status === 'processing') {
        this.opts.log(`Retomando geração ${job.id} (${job.provider})`);
        void this.run(job, null);
      }
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  async create(input: {
    provider: ProviderId;
    quality: QualityPreset;
    title?: string;
    images: InputImage[];
  }): Promise<Job> {
    const id = randomUUID();
    const dir = this.jobDir(id);
    await mkdir(dir, { recursive: true });
    const images = [];
    for (const image of input.images) {
      const name = `${image.view}.${EXT[image.mime]}`;
      await writeFile(path.join(dir, name), image.data);
      images.push({ view: image.view, url: `/api/files/${id}/${name}` });
    }
    const now = new Date().toISOString();
    const job: Job = {
      id,
      provider: input.provider,
      quality: input.quality,
      title: input.title?.trim().slice(0, 80) || `Carro ${new Date().toLocaleString('pt-BR')}`,
      status: 'queued',
      progress: 0,
      stage: 'Na fila',
      createdAt: now,
      updatedAt: now,
      images,
    };
    this.jobs.set(id, job);
    this.scheduleSave();
    void this.run(job, input.images);
    return job;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.jobs.delete(id)) return false;
    this.scheduleSave();
    await rm(this.jobDir(id), { recursive: true, force: true });
    return true;
  }

  private update(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    if (this.jobs.has(job.id)) this.scheduleSave();
  }

  private async run(job: Job, images: InputImage[] | null) {
    const provider = this.opts.providers[job.provider];
    try {
      if (!provider) throw new ProviderError(`Provedor desconhecido: ${job.provider}.`);
      if (!job.providerTaskId) {
        if (!images) throw new ProviderError('O servidor reiniciou antes de enviar as fotos. Gere novamente.');
        this.update(job, { status: 'processing', progress: 2, stage: 'Enviando fotos para a IA' });
        // Criação de tarefa é cobrada por envio: nunca repetimos automaticamente.
        const ref = await provider.start(images, job.quality);
        this.update(job, { providerTaskId: ref.taskId, providerMode: ref.mode, progress: 4, stage: 'Tarefa criada' });
      }
      const ref = { taskId: job.providerTaskId!, mode: job.providerMode ?? '' };
      const deadline = Date.now() + this.opts.timeoutMs;
      let failures = 0;
      for (;;) {
        if (!this.jobs.has(job.id)) return; // apagado durante a geração
        let result: ProviderPoll;
        try {
          result = await provider.poll(ref);
          failures = 0;
        } catch (err) {
          if (err instanceof ProviderError && err.retryable && ++failures < this.opts.maxPollFailures) {
            this.opts.log(`Polling de ${job.id} falhou (${failures}x): ${err.message}`);
            await this.opts.sleep(provider.pollIntervalMs * Math.min(failures, 4));
            continue;
          }
          throw err;
        }
        if (result.status === 'succeeded') {
          await this.finish(job, provider, result);
          return;
        }
        if (result.status === 'failed') throw new ProviderError(result.error ?? 'A geração falhou.');
        this.update(job, {
          status: 'processing',
          progress: Math.max(job.progress, Math.min(result.progress, 99)),
          stage: result.stage ?? job.stage,
        });
        if (Date.now() > deadline) throw new ProviderError('A geração demorou demais e foi interrompida.');
        await this.opts.sleep(provider.pollIntervalMs);
      }
    } catch (err) {
      this.opts.log(`Geração ${job.id} falhou: ${errorMessage(err)}`);
      this.update(job, {
        status: 'failed',
        stage: 'Falhou',
        error: errorMessage(err),
        finishedAt: new Date().toISOString(),
      });
    }
  }

  private async finish(job: Job, provider: Provider, result: ProviderPoll) {
    this.update(job, { progress: 99, stage: 'Baixando o modelo 3D' });
    const model = await this.withRetry(() => provider.download(result.modelUrl!));
    if (model.toString('ascii', 0, 4) !== 'glTF') {
      throw new ProviderError('O provedor devolveu um arquivo que não é GLB.');
    }
    if (!this.jobs.has(job.id)) return;
    await writeFile(path.join(this.jobDir(job.id), 'model.glb'), model);

    let thumbnailUrl: string | undefined;
    if (result.thumbnailUrl) {
      try {
        const thumb = await provider.download(result.thumbnailUrl);
        const mime = sniffImageMime(thumb);
        if (mime) {
          const name = `thumbnail.${EXT[mime]}`;
          await writeFile(path.join(this.jobDir(job.id), name), thumb);
          thumbnailUrl = `/api/files/${job.id}/${name}`;
        }
      } catch (err) {
        this.opts.log(`Miniatura de ${job.id} indisponível: ${errorMessage(err)}`);
      }
    }

    this.update(job, {
      status: 'succeeded',
      progress: 100,
      stage: 'Modelo pronto',
      modelUrl: `/api/files/${job.id}/model.glb`,
      thumbnailUrl,
      credits: result.credits,
      error: undefined,
      finishedAt: new Date().toISOString(),
    });
  }

  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ProviderError && err.retryable) || i >= attempts) throw err;
        await this.opts.sleep(1000 * 2 ** i);
      }
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saving = this.saving.then(() => this.writeIndex()).catch((err) => this.opts.log(`Erro ao salvar: ${err}`));
    }, 150);
  }

  private async writeIndex() {
    const tmp = `${this.indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.list(), null, 2));
    await rename(tmp, this.indexFile);
  }

  /** Grava o índice imediatamente (usado em testes e no desligamento). */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saving = this.saving.then(() => this.writeIndex());
    await this.saving;
  }
}
