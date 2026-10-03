import { useGLTF } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react';
import * as THREE from 'three';
import { applyLook, normalizeModel, prepareModel, type LookSettings, type ModelStats } from '../../lib/materials.ts';

export const DRACO_PATH = '/draco/';

interface Props {
  url: string;
  look: LookSettings;
  /** Giro manual em quartos de volta, para acertar a frente do carro. */
  quarterTurns: number;
  turntable: boolean;
  /** Grupo girado pela plataforma giratória (zerado ao trocar de câmera). */
  spinRef: RefObject<THREE.Group | null>;
  onReady: (info: { stats: ModelStats; size: THREE.Vector3 }) => void;
}

export function CarModel({ url, look, quarterTurns, turntable, spinRef, onReady }: Props) {
  const gltf = useGLTF(url, DRACO_PATH);
  const invalidate = useThree((s) => s.invalidate);

  const { scene, stats, size } = useMemo(() => {
    const scene = gltf.scene.clone(true);
    const stats = prepareModel(scene);
    const size = normalizeModel(scene);
    return { scene, stats, size };
  }, [gltf]);

  useEffect(() => {
    onReady({ stats, size });
  }, [stats, size, onReady]);

  useLayoutEffect(() => {
    applyLook(scene, look);
    invalidate();
  }, [scene, look, invalidate]);

  // Libera os materiais criados para este clone ao trocar de modelo.
  useEffect(
    () => () => {
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        const mats = mesh.userData?.originalMaterial;
        if (!mats) return;
        for (const m of Array.isArray(mats) ? mats : [mats]) (m as THREE.Material).dispose();
      });
    },
    [scene],
  );

  // O Canvas renderiza sob demanda; a plataforma giratória pede quadros enquanto ligada.
  useFrame((state, delta) => {
    if (!turntable || !spinRef.current) return;
    spinRef.current.rotation.y += Math.min(delta, 0.1) * 0.25;
    state.invalidate();
  });
  useEffect(() => {
    if (turntable) invalidate();
  }, [turntable, invalidate]);

  return (
    <group ref={spinRef}>
      <group rotation-y={(quarterTurns * Math.PI) / 2}>
        <primitive object={scene} />
      </group>
    </group>
  );
}
