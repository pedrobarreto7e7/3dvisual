import * as THREE from 'three';

export interface ModelStats {
  triangles: number;
  meshes: number;
  materials: number;
  maxTexture: number;
  hasPbrMaps: boolean;
}

export interface LookSettings {
  /** Intensidade do verniz automotivo (0 desliga). */
  clearcoat: number;
  clay: boolean;
  wireframe: boolean;
}

interface CarPaintUniforms {
  coatLo: { value: number };
  coatHi: { value: number };
}

/**
 * Converte um MeshStandardMaterial em MeshPhysicalMaterial preservando mapas e
 * fatores, e injeta uma máscara de verniz: o clearcoat só aparece onde a
 * superfície já é lisa (lataria, vidros), não em pneus e plásticos ásperos.
 * Modelos gerados por IA vêm com um único material, então o roughness da
 * textura é a melhor pista do que é pintura.
 */
export function toCarPaint(source: THREE.Material): THREE.MeshPhysicalMaterial {
  let mat: THREE.MeshPhysicalMaterial;
  if ((source as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    mat = (source as THREE.MeshPhysicalMaterial).clone();
  } else if ((source as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
    mat = new THREE.MeshPhysicalMaterial();
    THREE.MeshStandardMaterial.prototype.copy.call(mat, source as THREE.MeshStandardMaterial);
    // MeshStandardMaterial.copy sobrescreve os defines; restaura os do físico.
    mat.defines = { STANDARD: '', PHYSICAL: '' };
  } else {
    const basic = source as THREE.MeshBasicMaterial;
    mat = new THREE.MeshPhysicalMaterial({ map: basic.map ?? null, color: basic.color, roughness: 0.6 });
  }
  mat.name = source.name;

  const uniforms: CarPaintUniforms = { coatLo: { value: 0.32 }, coatHi: { value: 0.72 } };
  mat.userData.carPaint = uniforms;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.coatLo = uniforms.coatLo;
    shader.uniforms.coatHi = uniforms.coatHi;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float coatLo;\nuniform float coatHi;\nvoid main() {')
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= 1.0 - smoothstep( coatLo, coatHi, roughnessFactor );
#endif`,
      );
  };
  mat.customProgramCacheKey = () => 'car-paint-v1';
  return mat;
}

const clayMaterial = new THREE.MeshStandardMaterial({ color: '#c9c6c0', roughness: 0.55, metalness: 0 });

/** Prepara o modelo carregado: materiais físicos, sombras e estatísticas. */
export function prepareModel(root: THREE.Object3D): ModelStats {
  const seen = new Set<THREE.Material>();
  const converted = new Map<THREE.Material, THREE.MeshPhysicalMaterial>();
  let triangles = 0;
  let meshes = 0;
  let maxTexture = 0;
  let hasPbrMaps = false;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const geo = mesh.geometry;
    triangles += geo.index ? geo.index.count / 3 : (geo.attributes.position?.count ?? 0) / 3;

    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = list.map((m) => {
      seen.add(m);
      const std = m as THREE.MeshStandardMaterial;
      for (const tex of [std.map, std.normalMap, std.roughnessMap, std.metalnessMap, std.aoMap]) {
        const img = tex?.image as { width?: number } | undefined;
        if (img?.width) maxTexture = Math.max(maxTexture, img.width);
      }
      if (std.normalMap || std.roughnessMap || std.metalnessMap) hasPbrMaps = true;
      if (std.map) std.map.anisotropy = 8;
      if (!converted.has(m)) converted.set(m, toCarPaint(m));
      return converted.get(m)!;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    mesh.userData.originalMaterial = mesh.material;
  });

  return { triangles: Math.round(triangles), meshes, materials: seen.size, maxTexture, hasPbrMaps };
}

/** Aplica verniz, modo argila e wireframe sem recarregar o modelo. */
export function applyLook(root: THREE.Object3D, look: LookSettings) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.userData.originalMaterial) return;
    mesh.material = look.clay ? clayMaterial : mesh.userData.originalMaterial;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) {
      const mat = m as THREE.MeshPhysicalMaterial;
      mat.wireframe = look.wireframe;
      if (mat.userData.carPaint) {
        mat.clearcoat = look.clearcoat;
        mat.clearcoatRoughness = 0.06;
      }
    }
  });
}

/**
 * Centraliza o modelo no chão e escala para um carro de ~4,6 m de comprimento.
 * Se o comprimento estiver no eixo X, gira 90° para alinhar com Z.
 */
export function normalizeModel(root: THREE.Object3D, targetLength = 4.6) {
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());
  if (size.x > size.z * 1.15) {
    root.rotation.y -= Math.PI / 2;
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }
  const horizontal = Math.max(size.x, size.z) || 1;
  const scale = targetLength / horizontal;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
}
