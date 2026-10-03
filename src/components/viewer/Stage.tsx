import { ContactShadows, Environment, Lightformer, MeshReflectorMaterial } from '@react-three/drei';
import { useMemo } from 'react';
import { suspend } from 'suspend-react';
import * as THREE from 'three';
import type { EnvPreset } from './presets.ts';

const HDRI = {
  warehouse: () => import('@pmndrs/assets/hdri/warehouse.exr'),
  city: () => import('@pmndrs/assets/hdri/city.exr'),
  sunset: () => import('@pmndrs/assets/hdri/sunset.exr'),
  night: () => import('@pmndrs/assets/hdri/night.exr'),
};

/** Softboxes de estúdio fotográfico automotivo: faixas no teto, laterais e um "key light". */
function Softboxes({ kind }: { kind: 'studio' | 'ceiling' }) {
  return (
    <>
      {[-6, -2, 2, 6].map((z) => (
        <Lightformer
          key={z}
          form="rect"
          intensity={kind === 'studio' ? 2.2 : 1.4}
          rotation-x={Math.PI / 2}
          position={[0, 7, z]}
          scale={[12, 1.2, 1]}
        />
      ))}
      {kind === 'studio' && (
        <>
          <Lightformer intensity={2.5} rotation-y={Math.PI / 2} position={[-12, 2.5, 0]} scale={[30, 2.2, 1]} />
          <Lightformer intensity={2.5} rotation-y={-Math.PI / 2} position={[12, 2.5, 0]} scale={[30, 2.2, 1]} />
          <Lightformer intensity={1.2} position={[0, 2, -14]} scale={[16, 3, 1]} />
          <Lightformer
            form="ring"
            color="#fff3e0"
            intensity={6}
            scale={3}
            position={[8, 6, 9]}
            onUpdate={(self) => self.lookAt(0, 0, 0)}
          />
        </>
      )}
    </>
  );
}

function HdriEnvironment({ preset }: { preset: EnvPreset }) {
  const file = suspend(HDRI[preset.hdri!], ['hdri', preset.hdri]).default as string;
  return (
    <Environment
      files={file}
      resolution={512}
      background={preset.background === null}
      backgroundBlurriness={0.45}
      environmentIntensity={preset.intensity}
    >
      {preset.softboxes && <Softboxes kind={preset.softboxes} />}
    </Environment>
  );
}

/** Gradiente radial para alphaMap (lê o canal verde): preto no centro, branco nas bordas. */
function useRadialFade() {
  return useMemo(() => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, '#000');
    g.addColorStop(0.2, '#000');
    g.addColorStop(0.6, '#fff');
    g.addColorStop(1, '#fff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }, []);
}

function Backdrop({ preset }: { preset: EnvPreset }) {
  // Cúpula de fundo + véu radial da mesma cor sobre o piso: o chão se dissolve no
  // fundo sem linha de horizonte, como num estúdio fotográfico infinito. Os dois
  // são malhas com o mesmo material, então passam pelo mesmo pós-processamento.
  const fade = useRadialFade();
  if (!preset.background) return null;
  return (
    <group key={preset.id}>
      {preset.fog && <fog attach="fog" args={[preset.fog, 14, 34]} />}
      <mesh renderOrder={-1}>
        <sphereGeometry args={[70, 32, 16]} />
        <meshBasicMaterial color={preset.background} side={THREE.BackSide} depthWrite={false} toneMapped={false} fog={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.01} renderOrder={1}>
        <planeGeometry args={[100, 100]} />
        <meshBasicMaterial
          color={preset.background}
          alphaMap={fade}
          transparent
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>
    </group>
  );
}

export function Stage({ preset, light }: { preset: EnvPreset; light: number }) {
  return (
    <>
      <Backdrop preset={preset} />
      {preset.hdri ? (
        <HdriEnvironment preset={{ ...preset, intensity: preset.intensity * light }} />
      ) : (
        <Environment resolution={1024} environmentIntensity={preset.intensity * light}>
          <color attach="background" args={['#050505']} />
          {preset.softboxes && <Softboxes kind={preset.softboxes} />}
        </Environment>
      )}

      {/* Luz direcional suave para dar sombra projetada nítida sob o carro. */}
      <directionalLight
        position={[5, 9, 6]}
        intensity={1.1 * light}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
      />

      <ContactShadows
        position={[0, 0.002, 0]}
        scale={14}
        resolution={1024}
        far={3}
        blur={2.2}
        opacity={preset.floor === 'matte' && preset.background === null ? 0.85 : 0.75}
        color="#000000"
      />

      {preset.floor === 'reflective' ? (
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={[80, 80]} />
          <MeshReflectorMaterial
            blur={[400, 120]}
            resolution={1024}
            mixBlur={1}
            mixStrength={18}
            roughness={0.9}
            depthScale={1.1}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.3}
            color={preset.floorColor}
            metalness={0.6}
            mirror={0.6}
          />
        </mesh>
      ) : preset.background ? (
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={[80, 80]} />
          <meshStandardMaterial color={preset.floorColor} roughness={1} metalness={0} />
        </mesh>
      ) : (
        <mesh rotation-x={-Math.PI / 2} position-y={0.001} receiveShadow>
          <planeGeometry args={[30, 30]} />
          <shadowMaterial opacity={0.35} />
        </mesh>
      )}
    </>
  );
}
