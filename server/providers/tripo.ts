import type { CarView, QualityPreset } from '../../shared/types.ts';
import { CAR_VIEWS } from '../../shared/types.ts';
import {
  ProviderError,
  describeHttpError,
  downloadBuffer,
  type InputImage,
  type Provider,
  type ProviderPoll,
} from './types.ts';

// Documentação: https://developers.tripo3d.ai/en/docs/introduction (API v3)
const SINGLE = 'image-to-model';
const MULTI = 'multiview-to-model';

interface TripoTask {
  task_id: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown' | 'banned' | 'expired';
  progress?: number;
  queuing_num?: number;
  running_left_time?: number;
  output?: {
    pbr_model?: string;
    model_url?: string;
    model?: string;
    base_model?: string;
    rendered_image_url?: string;
    rendered_image?: string;
  };
  credits_consumed?: number | string;
  error_message?: string;
}

/**
 * - ultra:    v3.1 com geometria "detailed" e textura "extreme" + PBR.
 * - balanced: v3.1 com textura "detailed" + PBR.
 * - fast:     v2.5 com textura padrão + PBR.
 */
export function tripoQualityParams(quality: QualityPreset): Record<string, unknown> {
  const common = { texture: true, pbr: true, texture_alignment: 'original_image' };
  switch (quality) {
    case 'ultra':
      return { ...common, model: 'v3.1-20260211', geometry_quality: 'detailed', texture_quality: 'extreme' };
    case 'balanced':
      return { ...common, model: 'v3.1-20260211', geometry_quality: 'standard', texture_quality: 'detailed' };
    case 'fast':
      // geometry_quality não é aceito pela v2.5.
      return { ...common, model: 'v2.5-20250123', texture_quality: 'standard' };
  }
}

/** A Tripo espera exatamente 4 posições [frente, esquerda, trás, direita]; vazias viram "". */
export function tripoMultiviewInputs(tokens: Partial<Record<CarView, string>>): (string | { file_token: string })[] {
  return CAR_VIEWS.map((view) => (tokens[view] ? { file_token: tokens[view]! } : ''));
}

export function mapTripoTask(task: TripoTask): ProviderPoll {
  const progress = Math.max(0, Math.min(100, Math.round(Number(task.progress ?? 0))));
  switch (task.status) {
    case 'queued':
      return {
        status: 'pending',
        progress,
        stage: task.queuing_num ? `Na fila da Tripo (posição ${task.queuing_num})` : 'Na fila da Tripo',
      };
    case 'running': {
      const left = task.running_left_time;
      const eta = left && left > 0 ? ` · ~${Math.ceil(left)}s restantes` : '';
      return {
        status: 'running',
        progress,
        stage: (progress < 50 ? 'Esculpindo a geometria 3D' : 'Pintando texturas PBR') + eta,
      };
    }
    case 'success': {
      const out = task.output ?? {};
      const model = out.pbr_model ?? out.model_url ?? out.model ?? out.base_model;
      if (!model) return { status: 'failed', progress: 100, error: 'A Tripo concluiu, mas não retornou o modelo.' };
      const credits = Number(task.credits_consumed);
      return {
        status: 'succeeded',
        progress: 100,
        stage: 'Modelo pronto',
        modelUrl: model,
        thumbnailUrl: out.rendered_image_url ?? out.rendered_image,
        credits: Number.isFinite(credits) ? credits : undefined,
      };
    }
    case 'banned':
      return { status: 'failed', progress, error: 'A Tripo recusou a imagem (moderação de conteúdo).' };
    case 'expired':
      return { status: 'failed', progress, error: 'A tarefa expirou na Tripo.' };
    case 'cancelled':
      return { status: 'failed', progress, error: 'A tarefa foi cancelada na Tripo.' };
    case 'unknown':
      // Não é um estado terminal no SDK oficial: continue consultando.
      return { status: 'running', progress, stage: 'Aguardando a Tripo' };
    case 'failed':
    default:
      return {
        status: 'failed',
        progress,
        error: task.error_message ? `Tripo: ${task.error_message}` : 'A Tripo não conseguiu gerar o modelo.',
      };
  }
}

export function createTripoProvider(apiKey: string | undefined, baseUrl = 'https://openapi.tripo3d.ai/v3'): Provider {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: { json?: unknown; form?: FormData },
  ): Promise<T> {
    if (!apiKey) throw new ProviderError('Tripo não configurada: defina TRIPO_API_KEY no arquivo .env.');
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let payload: BodyInit | undefined;
    if (body?.form) payload = body.form;
    else if (body?.json !== undefined) {
      payload = JSON.stringify(body.json);
      headers['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(base + path, { method, headers, body: payload, signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      throw new ProviderError('Falha de rede ao falar com a Tripo.', { retryable: method === 'GET', cause: err });
    }
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* corpo não-JSON */
    }
    const detail = [json?.message, json?.suggestion].filter(Boolean).join(' — ') || text.slice(0, 200);
    if (!res.ok) throw describeHttpError('Tripo', res.status, detail);
    // Envelope padrão: { code, data, message, suggestion } — code 0 = sucesso.
    if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
      throw new ProviderError(`Tripo: ${detail || `erro ${json.code}`}`);
    }
    return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
  }

  async function upload(image: InputImage): Promise<string> {
    const ext = image.mime === 'image/png' ? 'png' : image.mime === 'image/webp' ? 'webp' : 'jpg';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image.data)], { type: image.mime }), `${image.view}.${ext}`);
    const res = await call<{ file_token?: string }>('POST', '/files', { form });
    if (!res?.file_token) throw new ProviderError('A Tripo não retornou o token do upload.');
    return res.file_token;
  }

  return {
    info: {
      id: 'tripo',
      name: 'Tripo',
      description: 'Tripo v3.1 com geometria detalhada e PBR. Com várias fotos, a frente é obrigatória.',
      configured: Boolean(apiKey),
      maxImages: 4,
      multiviewRequiresFront: true,
      qualities: [
        { id: 'ultra', label: 'Ultra realista', hint: 'v3.1 · geometria detalhada · textura extreme' },
        { id: 'balanced', label: 'Equilibrado', hint: 'v3.1 · textura detailed · PBR' },
        { id: 'fast', label: 'Econômico', hint: 'v2.5 · textura padrão · PBR' },
      ],
    },
    pollIntervalMs: 3000,
    async start(images, quality) {
      const params = tripoQualityParams(quality);
      if (images.length === 1) {
        const token = await upload(images[0]);
        const res = await call<{ task_id?: string }>('POST', `/generation/${SINGLE}`, {
          json: { input: { file_token: token }, ...params },
        });
        if (!res?.task_id) throw new ProviderError('A Tripo não retornou o ID da tarefa.');
        return { taskId: res.task_id, mode: SINGLE };
      }
      if (!images.some((i) => i.view === 'front')) {
        throw new ProviderError('Para várias fotos na Tripo, a foto da frente é obrigatória.');
      }
      const tokens: Partial<Record<CarView, string>> = {};
      for (const image of images) tokens[image.view] = await upload(image);
      const res = await call<{ task_id?: string }>('POST', `/generation/${MULTI}`, {
        json: { inputs: tripoMultiviewInputs(tokens), ...params },
      });
      if (!res?.task_id) throw new ProviderError('A Tripo não retornou o ID da tarefa.');
      return { taskId: res.task_id, mode: MULTI };
    },
    async poll(ref) {
      const task = await call<TripoTask>('GET', `/tasks/${encodeURIComponent(ref.taskId)}`);
      return mapTripoTask(task);
    },
    // Os links da Tripo expiram ~5 min após a conclusão: o servidor baixa na hora.
    download: (url) => downloadBuffer(url),
  };
}
