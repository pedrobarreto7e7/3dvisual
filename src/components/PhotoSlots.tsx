import { AlertTriangle, ImagePlus, X } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { CAR_VIEWS, VIEW_LABELS, type CarView } from '../../shared/types.ts';
import type { PreparedPhoto } from '../lib/image.ts';

interface Props {
  photos: Partial<Record<CarView, PreparedPhoto>>;
  busyView: CarView | null;
  maxImages: number;
  onAdd: (view: CarView, file: File) => void;
  onAddMany: (files: File[]) => void;
  onRemove: (view: CarView) => void;
  disabled?: boolean;
}

export function PhotoSlots({ photos, busyView, maxImages, onAdd, onAddMany, onRemove, disabled }: Props) {
  const views = CAR_VIEWS.slice(0, Math.max(1, maxImages));
  const [main, ...extras] = views;
  return (
    <div className="slots">
      <Slot
        view={main}
        photo={photos[main]}
        busy={busyView === main}
        large
        disabled={disabled}
        onFile={(file) => onAdd(main, file)}
        onFiles={onAddMany}
        onRemove={() => onRemove(main)}
      />
      {extras.length > 0 && (
        <div className="slots-extra">
          {extras.map((view) => (
            <Slot
              key={view}
              view={view}
              photo={photos[view]}
              busy={busyView === view}
              disabled={disabled}
              onFile={(file) => onAdd(view, file)}
              onFiles={onAddMany}
              onRemove={() => onRemove(view)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Slot({
  view,
  photo,
  busy,
  large,
  disabled,
  onFile,
  onFiles,
  onRemove,
}: {
  view: CarView;
  photo?: PreparedPhoto;
  busy: boolean;
  large?: boolean;
  disabled?: boolean;
  onFile: (file: File) => void;
  onFiles: (files: File[]) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const handleFiles = (list: FileList | null) => {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (files.length === 1) onFile(files[0]);
    else if (files.length > 1) onFiles(files);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`slot ${large ? 'large' : ''} ${over ? 'over' : ''} ${photo ? 'filled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {photo ? (
        <>
          <img src={photo.url} alt={VIEW_LABELS[view]} />
          <span className="slot-label">{VIEW_LABELS[view]}</span>
          {!disabled && (
            <button className="slot-remove" aria-label={`Remover foto ${VIEW_LABELS[view]}`} onClick={onRemove}>
              <X size={14} />
            </button>
          )}
          {photo.warnings.length > 0 && (
            <span className="slot-warn" title={photo.warnings.join('\n')}>
              <AlertTriangle size={12} /> {large ? photo.warnings[0] : 'Atenção'}
            </span>
          )}
        </>
      ) : (
        <button className="slot-empty" disabled={disabled || busy} onClick={() => input.current?.click()}>
          {busy ? (
            <div className="spinner small" />
          ) : (
            <>
              <ImagePlus size={large ? 28 : 18} />
              {large ? (
                <>
                  <strong>Arraste a foto do carro aqui</strong>
                  <span>ou clique para escolher · JPG, PNG ou WebP</span>
                </>
              ) : (
                <span>{VIEW_LABELS[view]}</span>
              )}
            </>
          )}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple={large}
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
