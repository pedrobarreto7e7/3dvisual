import type { CarView, ProviderInfo, QualityPreset } from '../../shared/types.ts';

export interface InputImage {
  view: CarView;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  data: Buffer;
}

/** Referência à tarefa criada no provedor; é persistida para retomar o polling. */
export interface ProviderTaskRef {
  taskId: string;
  /** Qual endpoint/modo foi usado — necessário para consultar o status depois. */
  mode: string;
}

export interface ProviderPoll {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  /** 0–100 */
  progress: number;
  stage?: string;
  modelUrl?: string;
  thumbnailUrl?: string;
  error?: string;
  credits?: number;
}

export interface Provider {
  info: ProviderInfo;
  pollIntervalMs: number;
  start(images: InputImage[], quality: QualityPreset): Promise<ProviderTaskRef>;
  poll(ref: ProviderTaskRef): Promise<ProviderPoll>;
  /** Baixa um arquivo de resultado (modelo ou miniatura). */
  download(url: string): Promise<Buffer>;
}

/** Erro com mensagem já pronta para o usuário final. */
export class ProviderError extends Error {
  /** Se true, vale a pena tentar de novo (rede instável, 5xx, 429). */
  readonly retryable: boolean;
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.retryable = options.retryable ?? false;
  }
}

export function toDataUri(image: InputImage): string {
  return `data:${image.mime};base64,${image.data.toString('base64')}`;
}

export async function downloadBuffer(url: string, maxBytes = 300 * 1024 * 1024): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  } catch (err) {
    throw new ProviderError('Falha de rede ao baixar o modelo gerado.', { retryable: true, cause: err });
  }
  if (!res.ok) {
    throw new ProviderError(`Não foi possível baixar o arquivo gerado (HTTP ${res.status}).`, {
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    throw new ProviderError('O arquivo gerado é grande demais.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new ProviderError('O arquivo gerado é grande demais.');
  return buf;
}

/** Converte respostas HTTP de erro em mensagens úteis em português. */
export function describeHttpError(provider: string, status: number, detail?: string): ProviderError {
  const suffix = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403) {
    return new ProviderError(`${provider}: chave de API inválida ou sem permissão${suffix}.`);
  }
  if (status === 402) {
    return new ProviderError(`${provider}: créditos insuficientes na conta${suffix}.`);
  }
  if (status === 429) {
    return new ProviderError(`${provider}: limite de requisições atingido, tente em instantes${suffix}.`, {
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError(`${provider}: o serviço está instável (HTTP ${status})${suffix}.`, { retryable: true });
  }
  return new ProviderError(`${provider}: requisição recusada (HTTP ${status})${suffix}.`);
}
