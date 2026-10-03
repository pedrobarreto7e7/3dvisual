export type EnvPresetId = 'studio' | 'showroom' | 'white' | 'city' | 'sunset' | 'night';

export interface EnvPreset {
  id: EnvPresetId;
  label: string;
  /** HDRI do pacote @pmndrs/assets (512 px, embutido no bundle). */
  hdri: 'warehouse' | 'city' | 'sunset' | 'night' | null;
  /** Painéis de luz (softboxes) desenhados no mapa de ambiente. */
  softboxes: 'studio' | 'ceiling' | null;
  /** Cor de fundo; null mostra o próprio HDRI desfocado. */
  background: string | null;
  floor: 'reflective' | 'matte';
  floorColor: string;
  /** Cor da "névoa" que funde o piso com o fundo. */
  fog?: string;
  intensity: number;
}

export const ENV_PRESETS: EnvPreset[] = [
  {
    id: 'studio',
    label: 'Estúdio',
    hdri: null,
    softboxes: 'studio',
    background: '#121317',
    floor: 'reflective',
    floorColor: '#0d0e11',
    fog: '#121317',
    intensity: 1.3,
  },
  {
    id: 'showroom',
    label: 'Showroom',
    hdri: 'warehouse',
    softboxes: 'ceiling',
    background: '#1a1b1f',
    floor: 'reflective',
    floorColor: '#1b1c20',
    fog: '#1a1b1f',
    intensity: 0.9,
  },
  {
    id: 'white',
    label: 'Fundo branco',
    // Ambiente escuro com softboxes (como num estúdio real com bandeiras pretas):
    // o fundo é branco, mas a lataria mantém contraste em vez de ficar lavada.
    hdri: null,
    softboxes: 'studio',
    background: '#f1f0ed',
    floor: 'matte',
    floorColor: '#f1f0ed',
    fog: '#f1f0ed',
    intensity: 1.2,
  },
  { id: 'city', label: 'Cidade', hdri: 'city', softboxes: null, background: null, floor: 'matte', floorColor: '#6d6f73', intensity: 1 },
  { id: 'sunset', label: 'Pôr do sol', hdri: 'sunset', softboxes: null, background: null, floor: 'matte', floorColor: '#5a4a44', intensity: 1.1 },
  { id: 'night', label: 'Noite', hdri: 'night', softboxes: 'ceiling', background: null, floor: 'matte', floorColor: '#08090c', intensity: 1.2 },
];

export type CameraPresetId = 'threeQuarter' | 'front' | 'side' | 'rear' | 'top';

export const CAMERA_PRESETS: { id: CameraPresetId; label: string }[] = [
  { id: 'threeQuarter', label: '3⁄4' },
  { id: 'front', label: 'Frente' },
  { id: 'side', label: 'Lateral' },
  { id: 'rear', label: 'Traseira' },
  { id: 'top', label: 'Topo' },
];

export interface ViewerSettings {
  env: EnvPresetId;
  clearcoat: number;
  light: number;
  turntable: boolean;
  postFx: boolean;
  clay: boolean;
  wireframe: boolean;
}

export const DEFAULT_VIEWER_SETTINGS: ViewerSettings = {
  env: 'studio',
  clearcoat: 0.6,
  light: 1,
  turntable: false,
  postFx: true,
  clay: false,
  wireframe: false,
};
