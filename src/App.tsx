import { Car, FolderOpen, Lightbulb, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CAR_VIEWS,
  type AppConfig,
  type CarView,
  type Job,
  type ProviderId,
  type QualityPreset,
} from '../shared/types.ts';
import { Garage } from './components/Garage.tsx';
import { JobProgress } from './components/JobCard.tsx';
import { PhotoSlots } from './components/PhotoSlots.tsx';
import { CarViewer, type ViewerModel } from './components/viewer/CarViewer.tsx';
import { DEFAULT_VIEWER_SETTINGS, type ViewerSettings } from './components/viewer/presets.ts';
import { api } from './lib/api.ts';
import { preparePhoto, type PreparedPhoto } from './lib/image.ts';

const SETTINGS_KEY = '3dvisual:viewer';
const DEMO_MODEL: ViewerModel = { url: '/api/demo-car.glb', title: 'Carro de demonstração', downloadName: 'carro-demo.glb' };

function loadSettings(): ViewerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return { ...DEFAULT_VIEWER_SETTINGS, ...(saved ?? {}) };
  } catch {
    return DEFAULT_VIEWER_SETTINGS;
  }
}

const isActive = (job: Job) => job.status === 'queued' || job.status === 'processing';

function jobModel(job: Job): ViewerModel {
  const slug = job.title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  return { url: job.modelUrl!, title: job.title, downloadName: `${slug || 'carro'}.glb` };
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [providerId, setProviderId] = useState<ProviderId>('demo');
  const [quality, setQuality] = useState<QualityPreset>('ultra');
  const [title, setTitle] = useState('');
  const [photos, setPhotos] = useState<Partial<Record<CarView, PreparedPhoto>>>({});
  const [busyView, setBusyView] = useState<CarView | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ViewerModel | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ViewerSettings>(loadSettings);
  const glbInput = useRef<HTMLInputElement>(null);
  const localUrl = useRef<string | null>(null);

  const provider = config?.providers.find((p) => p.id === providerId);
  const currentJob = jobs.find((j) => j.id === currentJobId) ?? null;
  const photoCount = Object.keys(photos).length;
  const hasRealProvider = config?.providers.some((p) => p.configured && p.id !== 'demo') ?? false;

  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg);
        setProviderId(cfg.defaultProvider);
        const first = cfg.providers.find((p) => p.id === cfg.defaultProvider)?.qualities[0];
        if (first) setQuality(first.id);
      })
      .catch((err) => setError(err.message));
    api.jobs().then(setJobs).catch(() => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* armazenamento indisponível: tudo bem */
    }
  }, [settings]);

  const openJob = useCallback((job: Job) => {
    if (job.status !== 'succeeded' || !job.modelUrl) return;
    setModel(jobModel(job));
    setSelectedId(job.id);
  }, []);

  // Atualiza a garagem enquanto houver geração em andamento.
  const anyActive = jobs.some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => {
      api
        .jobs()
        .then(setJobs)
        .catch(() => {
          /* servidor reiniciando: tenta de novo no próximo ciclo */
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [anyActive]);

  // Abre automaticamente o carro que acabou de ficar pronto.
  const currentStatus = currentJob?.status;
  useEffect(() => {
    if (currentJob && currentStatus === 'succeeded') openJob(currentJob);
  }, [currentStatus, currentJob?.id]);

  const selectProvider = (id: ProviderId) => {
    const next = config?.providers.find((p) => p.id === id);
    if (!next) return;
    setProviderId(id);
    if (!next.qualities.some((q) => q.id === quality)) setQuality(next.qualities[0].id);
  };

  const addPhoto = async (view: CarView, file: File) => {
    setError(null);
    setBusyView(view);
    try {
      const prepared = await preparePhoto(file);
      setPhotos((prev) => {
        if (prev[view]) URL.revokeObjectURL(prev[view]!.url);
        return { ...prev, [view]: prepared };
      });
      if (!title && view === 'front') setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 60));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyView(null);
    }
  };

  const addMany = async (files: File[]) => {
    const max = provider?.maxImages ?? 4;
    const free = CAR_VIEWS.slice(0, max).filter((v) => !photos[v]);
    for (const [i, file] of files.slice(0, free.length).entries()) await addPhoto(free[i], file);
    if (files.length > free.length) setError(`Só cabem ${max} fotos; as excedentes foram ignoradas.`);
  };

  const removePhoto = (view: CarView) => {
    setPhotos((prev) => {
      const next = { ...prev };
      if (next[view]) URL.revokeObjectURL(next[view]!.url);
      delete next[view];
      return next;
    });
  };

  const validation = useMemo(() => {
    if (!provider) return 'Carregando…';
    if (!provider.configured) return `${provider.name} precisa de chave de API (veja o README).`;
    if (photoCount === 0) return 'Adicione pelo menos uma foto.';
    if (photoCount > provider.maxImages) return `${provider.name} aceita até ${provider.maxImages} fotos.`;
    if (photoCount > 1 && provider.multiviewRequiresFront && !photos.front)
      return `Com várias fotos, ${provider.name} exige a foto da frente.`;
    return null;
  }, [provider, photoCount, photos.front]);

  const generate = async () => {
    if (validation || !provider) return;
    setError(null);
    setSubmitting(true);
    try {
      const blobs = Object.fromEntries(Object.entries(photos).map(([v, p]) => [v, p!.blob]));
      const job = await api.createJob({ provider: provider.id, quality, title, photos: blobs });
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setCurrentJobId(job.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteJob = async (job: Job) => {
    try {
      await api.deleteJob(job.id);
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      if (selectedId === job.id) {
        setModel(null);
        setSelectedId(null);
      }
      if (currentJobId === job.id) setCurrentJobId(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openLocalGlb = (file: File) => {
    if (localUrl.current) URL.revokeObjectURL(localUrl.current);
    localUrl.current = URL.createObjectURL(file);
    // O sufixo ajuda o carregador a reconhecer o formato a partir da URL.
    setModel({ url: `${localUrl.current}#.glb`, title: file.name.replace(/\.glb$/i, '') });
    setSelectedId(null);
  };

  const working = submitting || (currentJob !== null && isActive(currentJob));

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <div className="logo" aria-hidden>
            <Car size={18} />
          </div>
          <div>
            <h1>3DVisual</h1>
            <p>Foto do carro → modelo 3D realista</p>
          </div>
        </header>

        {config && !hasRealProvider && (
          <div className="notice">
            <strong>Modo demonstração.</strong> Nenhuma chave de IA foi configurada, então a conversão devolve um
            carro de exemplo. Adicione <code>MESHY_API_KEY</code> ou <code>TRIPO_API_KEY</code> no arquivo{' '}
            <code>.env</code> e reinicie o servidor para converter suas fotos de verdade.
          </div>
        )}

        <section className="step">
          <h2>
            <span className="step-n">1</span> Fotos do carro
            <span className="muted small">
              {photoCount}/{provider?.maxImages ?? 4}
            </span>
          </h2>
          <PhotoSlots
            photos={photos}
            busyView={busyView}
            maxImages={provider?.maxImages ?? 4}
            onAdd={addPhoto}
            onAddMany={addMany}
            onRemove={removePhoto}
            disabled={working}
          />
          <details className="tips">
            <summary>
              <Lightbulb size={14} /> Como tirar fotos que viram um 3D realista
            </summary>
            <ul>
              <li>Carro inteiro no quadro, sem cortar para-choques ou rodas.</li>
              <li>A melhor foto única é a 3⁄4 dianteira, na altura do farol.</li>
              <li>Luz uniforme (dia nublado ou sombra): reflexos fortes viram manchas na textura.</li>
              <li>Fundo limpo, sem pessoas ou outros carros na frente.</li>
              <li>Mais ângulos (lateral, traseira) melhoram muito a geometria escondida.</li>
            </ul>
          </details>
        </section>

        <section className="step">
          <h2>
            <span className="step-n">2</span> Motor de IA
          </h2>
          <div className="choices" role="radiogroup" aria-label="Provedor">
            {config?.providers.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={p.id === providerId}
                className={`choice ${p.id === providerId ? 'active' : ''}`}
                disabled={!p.configured || working}
                onClick={() => selectProvider(p.id)}
                title={p.configured ? p.description : `Configure a chave de ${p.name} no .env`}
              >
                <span className="choice-title">
                  {p.name}
                  <span className={`badge ${p.configured ? 'ok' : ''}`}>
                    {p.id === 'demo' ? 'grátis' : p.configured ? 'ativo' : 'sem chave'}
                  </span>
                </span>
                <span className="choice-desc">{p.description}</span>
              </button>
            ))}
          </div>
          {provider && provider.qualities.length > 1 && (
            <div className="quality" role="radiogroup" aria-label="Qualidade">
              {provider.qualities.map((q) => (
                <label key={q.id} className={`quality-opt ${q.id === quality ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="quality"
                    value={q.id}
                    checked={q.id === quality}
                    disabled={working}
                    onChange={() => setQuality(q.id)}
                  />
                  <span>
                    <strong>{q.label}</strong>
                    <span className="muted small">{q.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>

        <section className="step">
          <h2>
            <span className="step-n">3</span> Gerar modelo 3D
          </h2>
          <input
            className="text-input"
            placeholder="Nome (ex.: Civic 2020 prata)"
            value={title}
            maxLength={80}
            disabled={working}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="primary" disabled={Boolean(validation) || working} onClick={generate}>
            <Wand2 size={18} />
            {submitting ? 'Enviando…' : working ? 'Gerando…' : 'Transformar em 3D'}
          </button>
          {validation && !working && photoCount > 0 && <p className="muted small">{validation}</p>}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {currentJob && <JobProgress job={currentJob} provider={config?.providers.find((p) => p.id === currentJob.provider)} />}
        </section>

        <section className="step">
          <h2>
            Garagem
            <span className="h2-actions">
              <button className="link" onClick={() => glbInput.current?.click()}>
                Abrir .glb
              </button>
              <button
                className="link"
                onClick={() => {
                  setModel(DEMO_MODEL);
                  setSelectedId(null);
                }}
              >
                Exemplo
              </button>
            </span>
          </h2>
          <Garage jobs={jobs} selectedId={selectedId} onOpen={openJob} onDelete={deleteJob} />
        </section>
      </aside>

      <main className="stage">
        <CarViewer
          model={model}
          settings={settings}
          onSettingsChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
          emptyState={
            <div className="empty">
              <div className="empty-icon" aria-hidden>
                <Car size={34} />
              </div>
              <h3>Seu carro em 3D aparece aqui</h3>
              <p>Envie uma ou mais fotos ao lado e clique em “Transformar em 3D”.</p>
              <div className="empty-actions">
                <button className="secondary" onClick={() => setModel(DEMO_MODEL)}>
                  <Car size={16} /> Ver carro de exemplo
                </button>
                <button className="secondary" onClick={() => glbInput.current?.click()}>
                  <FolderOpen size={16} /> Abrir arquivo .glb
                </button>
              </div>
            </div>
          }
        />
      </main>

      <input
        ref={glbInput}
        type="file"
        accept=".glb,model/gltf-binary"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) openLocalGlb(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
