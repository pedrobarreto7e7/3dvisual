import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Job, ProviderInfo } from '../../shared/types.ts';

export function JobProgress({ job, provider }: { job: Job; provider?: ProviderInfo }) {
  const elapsed = useElapsed(job.createdAt, job.status === 'queued' || job.status === 'processing');
  const active = job.status === 'queued' || job.status === 'processing';
  return (
    <div className={`job-progress ${job.status}`} role="status" aria-live="polite">
      <div className="job-progress-head">
        {active && <Loader2 className="spin" size={16} />}
        {job.status === 'succeeded' && <CheckCircle2 size={16} />}
        {job.status === 'failed' && <XCircle size={16} />}
        <strong>{job.status === 'failed' ? 'A geração falhou' : job.stage}</strong>
        <span className="muted">{active ? elapsed : ''}</span>
      </div>
      {active && (
        <div className="bar" aria-hidden>
          <div style={{ width: `${Math.max(3, job.progress)}%` }} />
        </div>
      )}
      <div className="job-progress-foot muted">
        {job.status === 'failed'
          ? job.error
          : active
            ? `${provider?.name ?? job.provider} · ${job.progress}% · ${
                job.provider === 'demo' ? 'simulação rápida' : 'costuma levar de 1 a 5 minutos'
              }`
            : `${provider?.name ?? job.provider}${job.credits ? ` · ${job.credits} créditos` : ''}`}
      </div>
    </div>
  );
}

function useElapsed(since: string, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
