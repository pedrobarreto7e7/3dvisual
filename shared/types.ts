// Tipos compartilhados entre o servidor (server/) e o frontend (src/).

export type ProviderId = 'meshy' | 'tripo' | 'demo';

export type QualityPreset = 'ultra' | 'balanced' | 'fast';

/** Ângulo da foto. A ordem segue a convenção multivista da Tripo. */
export type CarView = 'front' | 'left' | 'back' | 'right';

export const CAR_VIEWS: CarView[] = ['front', 'left', 'back', 'right'];

export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'failed';

export interface JobImage {
  view: CarView;
  /** Caminho servido pela API, ex.: /api/files/<job>/front.jpg */
  url: string;
}

export interface Job {
  id: string;
  provider: ProviderId;
  quality: QualityPreset;
  title: string;
  status: JobStatus;
  /** 0–100 */
  progress: number;
  /** Etapa legível para o usuário (pt-BR). */
  stage: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  images: JobImage[];
  /** ID da tarefa no provedor (para retomar após reinício do servidor). */
  providerTaskId?: string;
  /** Endpoint do provedor usado (ex.: image-to-3d ou multi-image-to-3d). */
  providerMode?: string;
  modelUrl?: string;
  thumbnailUrl?: string;
  error?: string;
  /** Créditos consumidos, quando o provedor informa. */
  credits?: number;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  configured: boolean;
  /** Máximo de fotos aceitas numa única geração. */
  maxImages: number;
  /** Ângulos exigidos quando mais de uma foto é enviada. */
  multiviewRequiresFront: boolean;
  qualities: { id: QualityPreset; label: string; hint: string }[];
}

export interface AppConfig {
  providers: ProviderInfo[];
  defaultProvider: ProviderId;
}

export const VIEW_LABELS: Record<CarView, string> = {
  front: 'Frente / 3⁄4 dianteira',
  left: 'Lateral esquerda',
  back: 'Traseira',
  right: 'Lateral direita',
};
