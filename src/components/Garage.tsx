import { Loader2, Trash2, XCircle } from 'lucide-react';
import type { Job } from '../../shared/types.ts';

interface Props {
  jobs: Job[];
  selectedId: string | null;
  onOpen: (job: Job) => void;
  onDelete: (job: Job) => void;
}

export function Garage({ jobs, selectedId, onOpen, onDelete }: Props) {
  if (jobs.length === 0) {
    return <p className="muted small">Os carros que você gerar ficam guardados aqui.</p>;
  }
  return (
    <ul className="garage">
      {jobs.map((job) => {
        const thumb = job.thumbnailUrl ?? job.images[0]?.url;
        const active = job.status === 'queued' || job.status === 'processing';
        return (
          <li key={job.id} className={job.id === selectedId ? 'selected' : ''}>
            <button
              className="garage-item"
              disabled={job.status !== 'succeeded'}
              onClick={() => onOpen(job)}
              title={job.status === 'failed' ? job.error : job.title}
            >
              <span className="garage-thumb">
                {thumb && <img src={thumb} alt="" loading="lazy" />}
                {active && (
                  <span className="garage-overlay">
                    <Loader2 className="spin" size={16} />
                    {job.progress}%
                  </span>
                )}
                {job.status === 'failed' && (
                  <span className="garage-overlay failed">
                    <XCircle size={16} />
                  </span>
                )}
              </span>
              <span className="garage-meta">
                <strong>{job.title}</strong>
                <span className="muted">
                  {job.provider === 'demo' ? 'Demonstração' : job.provider === 'meshy' ? 'Meshy' : 'Tripo'} ·{' '}
                  {new Date(job.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                </span>
              </span>
            </button>
            <button
              className="icon-btn ghost"
              aria-label={`Apagar ${job.title}`}
              title="Apagar"
              onClick={() => {
                if (confirm(`Apagar "${job.title}" da garagem?`)) onDelete(job);
              }}
            >
              <Trash2 size={14} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
