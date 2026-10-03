import type { QualityPreset } from '../../shared/types.ts';
import {
  ProviderError,
  describeHttpError,
  downloadBuffer,
  toDataUri,
  type InputImage,
  type Provider,
  type ProviderPoll,
  type ProviderTaskRef,
} from './types.ts';

// Documentação: https://docs.meshy.ai/en/api/image-to-3d e /multi-image-to-3d
const SINGLE = '/openapi/v1/image-to-3d';
const MULTI = '/openapi/v1/multi-image-to-3d';

interface MeshyTask {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress?: number;
  phase?: string;
  preceding_tasks?: number;
  model_urls?: { glb?: string };
  thumbnail_url?: string;
  consumed_credits?: number;
  task_error?: { message?: string };
}

/**
 * Monta o corpo da requisição para cada preset.
 *
 * - ultra:    Meshy 7 + ultra_mode (passo extra de detalhe geométrico, só com 1 foto),
 *             texturas PBR com base color em 4K e malha original (sem remesh).
 * - balanced: Meshy 7 + PBR com texturas 2K.
 * - fast:     Meshy 5 (geração anterior, bem mais barata) + PBR, remesh em 50k polígonos.
 */
export function buildMeshyBody(images: InputImage[], quality: QualityPreset): Record<string, unknown> {
  const multi = images.length > 1;
  const body: Record<string, unknown> = multi
    ? { image_urls: images.map(toDataUri) }
    : { image_url: toDataUri(images[0]) };

  body.should_texture = true;
  body.enable_pbr = true;
  body.target_formats = ['glb'];

  switch (quality) {
    case 'ultra':
      body.ai_model = 'meshy-7';
      body.texture_resolution = '4k';
      body.should_remesh = false;
      // ultra_mode só existe na geração com uma única imagem.
      if (!multi) body.ultra_mode = true;
      break;
    case 'balanced':
      body.ai_model = 'meshy-7';
      body.texture_resolution = '2k';
      body.should_remesh = false;
      break;
    case 'fast':
      body.ai_model = 'meshy-5';
      body.should_remesh = true;
      body.topology = 'triangle';
      body.target_polycount = 50_000;
      break;
  }
  return body;
}

export function mapMeshyTask(task: MeshyTask): ProviderPoll {
  const progress = Math.max(0, Math.min(100, Math.round(task.progress ?? 0)));
  switch (task.status) {
    case 'PENDING': {
      const ahead = task.preceding_tasks;
      return {
        status: 'pending',
        progress,
        stage: ahead ? `Na fila da Meshy (${ahead} tarefa${ahead > 1 ? 's' : ''} à frente)` : 'Na fila da Meshy',
      };
    }
    case 'IN_PROGRESS':
      return { status: 'running', progress, stage: meshyStage(task.phase, progress) };
    case 'SUCCEEDED': {
      const glb = task.model_urls?.glb;
      if (!glb) return { status: 'failed', progress: 100, error: 'A Meshy concluiu, mas não retornou um arquivo GLB.' };
      return {
        status: 'succeeded',
        progress: 100,
        stage: 'Modelo pronto',
        modelUrl: glb,
        thumbnailUrl: task.thumbnail_url,
        credits: task.consumed_credits,
      };
    }
    case 'CANCELED':
      return { status: 'failed', progress, error: 'A tarefa foi cancelada na Meshy.' };
    case 'FAILED':
    default:
      return {
        status: 'failed',
        progress,
        error: task.task_error?.message ? `Meshy: ${task.task_error.message}` : 'A Meshy não conseguiu gerar o modelo.',
      };
  }
}

function meshyStage(phase: string | undefined, progress: number): string {
  if (phase === 'texture') return 'Pintando texturas PBR';
  if (phase === 'draft' || phase === 'generate') return 'Esculpindo a geometria 3D';
  if (progress < 15) return 'Analisando a foto';
  if (progress < 60) return 'Esculpindo a geometria 3D';
  return 'Pintando texturas PBR';
}

export function createMeshyProvider(apiKey: string | undefined, baseUrl = 'https://api.meshy.ai'): Provider {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!apiKey) throw new ProviderError('Meshy não configurada: defina MESHY_API_KEY no arquivo .env.');
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProviderError('Falha de rede ao falar com a Meshy.', { retryable: method === 'GET', cause: err });
    }
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok) throw describeHttpError('Meshy', res.status, json?.message ?? text.slice(0, 200));
    return json as T;
  }

  return {
    info: {
      id: 'meshy',
      name: 'Meshy',
      description: 'Meshy 7 com texturas PBR em até 4K. Aceita até 4 fotos de ângulos diferentes.',
      configured: Boolean(apiKey),
      maxImages: 4,
      multiviewRequiresFront: false,
      qualities: [
        { id: 'ultra', label: 'Ultra realista', hint: 'Meshy 7 Ultra · PBR · textura 4K' },
        { id: 'balanced', label: 'Equilibrado', hint: 'Meshy 7 · PBR · textura 2K' },
        { id: 'fast', label: 'Econômico', hint: 'Meshy 5 · PBR · 50k polígonos' },
      ],
    },
    pollIntervalMs: 5000,
    async start(images, quality) {
      const mode = images.length > 1 ? MULTI : SINGLE;
      const res = await call<{ result?: string }>('POST', mode, buildMeshyBody(images, quality));
      if (!res?.result) throw new ProviderError('A Meshy não retornou o ID da tarefa.');
      return { taskId: res.result, mode };
    },
    async poll(ref: ProviderTaskRef) {
      const mode = ref.mode === MULTI ? MULTI : SINGLE;
      const task = await call<MeshyTask>('GET', `${mode}/${encodeURIComponent(ref.taskId)}`);
      return mapMeshyTask(task);
    },
    download: (url) => downloadBuffer(url),
  };
}
