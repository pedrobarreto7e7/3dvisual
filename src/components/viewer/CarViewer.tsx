import { CameraControls, Html, useProgress } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from '@react-three/postprocessing';
import {
  Box,
  Camera,
  Download,
  Grid3x3,
  Maximize,
  Minimize,
  RotateCw,
  Sparkles,
  SlidersHorizontal,
  RefreshCcw,
} from 'lucide-react';
import { ToneMappingMode } from 'postprocessing';
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import type { ModelStats } from '../../lib/materials.ts';
import { CarModel } from './CarModel.tsx';
import {
  CAMERA_PRESETS,
  ENV_PRESETS,
  type CameraPresetId,
  type ViewerSettings,
} from './presets.ts';
import { Stage } from './Stage.tsx';

export interface ViewerModel {
  url: string;
  title: string;
  /** Nome do arquivo para download; ausente quando o modelo veio do próprio usuário. */
  downloadName?: string;
}

interface Props {
  model: ViewerModel | null;
  settings: ViewerSettings;
  onSettingsChange: (patch: Partial<ViewerSettings>) => void;
  emptyState: ReactNode;
}

function Loader() {
  const { progress } = useProgress();
  return (
    <Html center>
      <div className="viewer-loading">
        <div className="spinner" />
        <span>Carregando modelo… {Math.round(progress)}%</span>
      </div>
    </Html>
  );
}

class ModelErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <Html center>
          <div className="viewer-loading error">Não foi possível abrir este modelo 3D.</div>
        </Html>
      );
    }
    return this.props.children;
  }
}

const CAMERA_DIRS: Record<CameraPresetId, [number, number, number]> = {
  threeQuarter: [0.66, 0.26, 0.74],
  front: [0, 0.14, 1],
  side: [1, 0.1, 0],
  rear: [0, 0.16, -1],
  top: [0, 1, 0.001],
};

/** Posiciona a câmera de modo que a esfera envolvente do carro caiba no quadro. */
function cameraPose(id: CameraPresetId, size: THREE.Vector3, camera: THREE.Camera) {
  const cam = camera as THREE.PerspectiveCamera;
  const vFov = THREE.MathUtils.degToRad(cam.fov ?? 32);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (cam.aspect || 1));
  const radius = size.length() / 2;
  const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.92;
  const target = new THREE.Vector3(0, size.y * 0.4, 0);
  const position = new THREE.Vector3(...CAMERA_DIRS[id]).normalize().multiplyScalar(distance).add(target);
  return { position, target };
}

export function CarViewer({ model, settings, onSettingsChange, emptyState }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<CameraControls>(null);
  const spinRef = useRef<THREE.Group>(null);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const [info, setInfo] = useState<{ stats: ModelStats; size: THREE.Vector3 } | null>(null);
  const [quarterTurns, setQuarterTurns] = useState(0);
  const [activeCam, setActiveCam] = useState<CameraPresetId>('threeQuarter');
  const [fullscreen, setFullscreen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const preset = ENV_PRESETS.find((p) => p.id === settings.env) ?? ENV_PRESETS[0];
  const look = useMemo(
    () => ({ clearcoat: settings.clearcoat, clay: settings.clay, wireframe: settings.wireframe }),
    [settings.clearcoat, settings.clay, settings.wireframe],
  );

  useEffect(() => {
    setInfo(null);
    setQuarterTurns(0);
  }, [model?.url]);

  const goTo = useCallback(
    (id: CameraPresetId, animate = true) => {
      const controls = controlsRef.current;
      if (!controls) return;
      const size = info?.size ?? new THREE.Vector3(1.9, 1.4, 4.6);
      const { position, target } = cameraPose(id, size, controls.camera);
      if (spinRef.current) spinRef.current.rotation.y = 0;
      setActiveCam(id);
      void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, animate);
    },
    [info],
  );

  const handleReady = useCallback((next: { stats: ModelStats; size: THREE.Vector3 }) => setInfo(next), []);

  // Enquadra o carro assim que ele termina de carregar.
  useEffect(() => {
    if (info) goTo('threeQuarter', false);
  }, [info, goTo]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const screenshot = () => {
    const canvas = glRef.current?.domElement;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${(model?.title ?? 'carro').replace(/[^\w\-]+/g, '_')}.png`;
    a.click();
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen();
  };

  return (
    <div className={`viewer ${preset.background && isLight(preset.background) ? 'on-light' : ''}`} ref={wrapRef}>
      <Canvas
        frameloop="demand"
        shadows
        dpr={[1, 2]}
        camera={{ position: [6.5, 2.4, 7.5], fov: 32, near: 0.1, far: 200 }}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        onCreated={({ gl }) => {
          glRef.current = gl;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
        }}
      >
        <Suspense fallback={null}>
          <Stage preset={preset} light={settings.light} />
        </Suspense>

        {model && (
          <ModelErrorBoundary resetKey={model.url}>
            <Suspense fallback={<Loader />}>
              <CarModel
                key={model.url}
                url={model.url}
                look={look}
                quarterTurns={quarterTurns}
                turntable={settings.turntable}
                spinRef={spinRef}
                onReady={handleReady}
              />
            </Suspense>
          </ModelErrorBoundary>
        )}

        <CameraControls
          ref={controlsRef}
          makeDefault
          minDistance={2.5}
          maxDistance={30}
          maxPolarAngle={Math.PI / 2 - 0.03}
          smoothTime={0.35}
          dollyToCursor
        />

        {settings.postFx && (
          <EffectComposer multisampling={4}>
            <N8AO aoRadius={0.5} distanceFalloff={0.6} intensity={2.2} halfRes />
            <Bloom luminanceThreshold={1.1} mipmapBlur intensity={0.35} />
            <Vignette offset={0.32} darkness={isLight(preset.background) ? 0.15 : 0.45} />
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          </EffectComposer>
        )}
      </Canvas>

      {!model && <div className="viewer-empty">{emptyState}</div>}

      <div className="viewer-top">
        <div className="pill-group" role="radiogroup" aria-label="Ambiente">
          {ENV_PRESETS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={p.id === settings.env}
              className={`pill ${p.id === settings.env ? 'active' : ''}`}
              onClick={() => onSettingsChange({ env: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="viewer-tools">
          <IconToggle
            label="Plataforma giratória"
            active={settings.turntable}
            onClick={() => onSettingsChange({ turntable: !settings.turntable })}
          >
            <RotateCw size={16} />
          </IconToggle>
          <IconToggle
            label="Modo argila (ver só a geometria)"
            active={settings.clay}
            onClick={() => onSettingsChange({ clay: !settings.clay })}
          >
            <Box size={16} />
          </IconToggle>
          <IconToggle
            label="Malha (wireframe)"
            active={settings.wireframe}
            onClick={() => onSettingsChange({ wireframe: !settings.wireframe })}
          >
            <Grid3x3 size={16} />
          </IconToggle>
          <IconToggle
            label="Efeitos cinematográficos (oclusão, bloom)"
            active={settings.postFx}
            onClick={() => onSettingsChange({ postFx: !settings.postFx })}
          >
            <Sparkles size={16} />
          </IconToggle>
          <IconToggle label="Ajustes de material e luz" active={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
            <SlidersHorizontal size={16} />
          </IconToggle>
        </div>
        {panelOpen && (
          <div className="viewer-panel">
            <label>
              <span>
                Verniz automotivo <output>{Math.round(settings.clearcoat * 100)}%</output>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.clearcoat}
                onChange={(e) => onSettingsChange({ clearcoat: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>
                Intensidade da luz <output>{Math.round(settings.light * 100)}%</output>
              </span>
              <input
                type="range"
                min={0.3}
                max={2}
                step={0.05}
                value={settings.light}
                onChange={(e) => onSettingsChange({ light: Number(e.target.value) })}
              />
            </label>
            <p className="hint">O verniz só realça áreas lisas (lataria e vidros), não pneus e plásticos.</p>
          </div>
        )}
      </div>

      {model && (
        <div className="viewer-bottom">
          <div className="pill-group" aria-label="Câmera">
            {CAMERA_PRESETS.map((c) => (
              <button
                key={c.id}
                className={`pill ${c.id === activeCam ? 'active' : ''}`}
                onClick={() => goTo(c.id)}
              >
                {c.label}
              </button>
            ))}
            <button
              className="pill"
              title="Girar o carro 90° (se a frente estiver no lugar errado)"
              onClick={() => setQuarterTurns((q) => (q + 1) % 4)}
            >
              <RefreshCcw size={14} /> 90°
            </button>
          </div>
          <div className="viewer-actions">
            {info && (
              <span className="stats">
                {formatCount(info.stats.triangles)} triângulos
                {info.stats.maxTexture > 0 && ` · textura ${info.stats.maxTexture}px`}
                {info.stats.hasPbrMaps && ' · PBR'}
              </span>
            )}
            <button className="icon-btn" title="Salvar imagem (PNG)" aria-label="Salvar imagem" onClick={screenshot}>
              <Camera size={16} />
            </button>
            {model.downloadName && (
              <a className="icon-btn" title="Baixar modelo 3D (.glb)" aria-label="Baixar GLB" href={model.url} download={model.downloadName}>
                <Download size={16} />
              </a>
            )}
            <button
              className="icon-btn"
              title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
              aria-label="Tela cheia"
              onClick={toggleFullscreen}
            >
              {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IconToggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={`icon-btn ${active ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

function isLight(color: string | null) {
  if (!color) return false;
  const c = new THREE.Color(color);
  return c.r * 0.299 + c.g * 0.587 + c.b * 0.114 > 0.6;
}

function formatCount(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
