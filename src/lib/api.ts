import type { AppConfig, CarView, Job, ProviderId, QualityPreset } from '../../shared/types.ts';

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    throw new Error('Sem conexão com o servidor. Ele está rodando? (npm run dev)');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Erro HTTP ${res.status}`);
  return body as T;
}

export const api = {
  config: () => request<AppConfig>('/api/config'),
  jobs: () => request<Job[]>('/api/jobs'),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  deleteJob: (id: string) => request<void>(`/api/jobs/${id}`, { method: 'DELETE' }),
  createJob(input: {
    provider: ProviderId;
    quality: QualityPreset;
    title: string;
    photos: Partial<Record<CarView, Blob>>;
  }) {
    const form = new FormData();
    form.set('provider', input.provider);
    form.set('quality', input.quality);
    form.set('title', input.title);
    for (const [view, blob] of Object.entries(input.photos)) {
      if (blob) form.set(view, blob, `${view}.${blob.type === 'image/png' ? 'png' : 'jpg'}`);
    }
    return request<Job>('/api/jobs', { method: 'POST', body: form });
  },
};
