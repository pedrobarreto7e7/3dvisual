import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Provider, ProviderPoll } from './types.ts';

export const DEMO_MODEL_PATH = fileURLToPath(new URL('../assets/demo-car.glb', import.meta.url));
const DEMO_URL = 'demo://demo-car.glb';
const DURATION_MS = 9000;

const STAGES: [number, string][] = [
  [0, 'Analisando a foto'],
  [20, 'Removendo o fundo'],
  [40, 'Esculpindo a geometria 3D'],
  [70, 'Pintando texturas PBR'],
  [90, 'Otimizando o modelo'],
];

/**
 * Provedor de demonstração: não usa IA nem a sua foto. Simula as etapas e devolve
 * um carro procedural de exemplo, para testar o app sem chave de API.
 * O instante de início fica no próprio ID, então o polling sobrevive a reinícios.
 */
export function createDemoProvider(now: () => number = Date.now): Provider {
  return {
    info: {
      id: 'demo',
      name: 'Demonstração',
      description: 'Sem IA: simula a conversão e mostra um carro de exemplo. Use para testar o app sem chave de API.',
      configured: true,
      maxImages: 4,
      multiviewRequiresFront: false,
      qualities: [{ id: 'balanced', label: 'Demonstração', hint: 'Carro de exemplo, sem custo' }],
    },
    pollIntervalMs: 400,
    async start() {
      return { taskId: `demo-${now()}`, mode: 'demo' };
    },
    async poll(ref): Promise<ProviderPoll> {
      const started = Number(ref.taskId.replace(/^demo-/, ''));
      const elapsed = Number.isFinite(started) ? now() - started : DURATION_MS;
      if (elapsed >= DURATION_MS) {
        return { status: 'succeeded', progress: 100, stage: 'Modelo pronto', modelUrl: DEMO_URL, credits: 0 };
      }
      const progress = Math.round((elapsed / DURATION_MS) * 100);
      const stage = [...STAGES].reverse().find(([at]) => progress >= at)?.[1];
      return { status: 'running', progress, stage };
    },
    async download(url) {
      if (url !== DEMO_URL) throw new Error(`URL de demonstração inesperada: ${url}`);
      return readFile(DEMO_MODEL_PATH);
    },
  };
}
