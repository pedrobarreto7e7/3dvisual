/**
 * Gera server/assets/demo-car.glb: um cupê esportivo procedural usado pelo
 * modo demonstração (quando não há chave de API configurada).
 *
 *   npm run demo-car
 *
 * Unidades em metros, Y para cima. O carro é modelado com a frente em +X e
 * girado no final para apontar para +Z (convenção do glTF).
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// O GLTFExporter usa FileReader para montar o .glb; o Node não tem essa API.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    blob.arrayBuffer().then((buf) => this.done(buf));
  }
  readAsDataURL(blob: Blob) {
    blob
      .arrayBuffer()
      .then((buf) => this.done(`data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`));
  }
  private done(result: ArrayBuffer | string) {
    this.result = result;
    this.onload?.();
    this.onloadend?.();
  }
}
(globalThis as any).FileReader ??= NodeFileReader;

const HALF = 2.3; // meio comprimento
const WIDTH = 1.94;
const WHEEL_R = 0.36;
const ARCH_R = WHEEL_R + 0.055;
const FRONT_AXLE = 1.43;
const REAR_AXLE = -1.33;
const SILL = 0.26;
const TRACK = WIDTH / 2 - 0.16;

// ── Materiais ────────────────────────────────────────────────────────────────
const paint = new THREE.MeshPhysicalMaterial({
  name: 'paint',
  color: '#8f0d16',
  metalness: 0.55,
  roughness: 0.3,
  clearcoat: 1,
  clearcoatRoughness: 0.03,
});
const glass = new THREE.MeshPhysicalMaterial({
  name: 'glass',
  color: '#07090c',
  metalness: 0.1,
  roughness: 0.03,
  clearcoat: 1,
  clearcoatRoughness: 0,
});
const trim = new THREE.MeshStandardMaterial({ name: 'trim', color: '#0f1012', metalness: 0.25, roughness: 0.5 });
const chrome = new THREE.MeshStandardMaterial({ name: 'chrome', color: '#dfe3e8', metalness: 1, roughness: 0.1 });
const rimMat = new THREE.MeshStandardMaterial({ name: 'rim', color: '#a3a9b0', metalness: 1, roughness: 0.2 });
const tireMat = new THREE.MeshStandardMaterial({ name: 'tire', color: '#141414', metalness: 0, roughness: 0.9 });
const brake = new THREE.MeshStandardMaterial({ name: 'brake', color: '#55585c', metalness: 0.9, roughness: 0.38 });
const caliper = new THREE.MeshStandardMaterial({ name: 'caliper', color: '#d9a21b', metalness: 0.3, roughness: 0.35 });
const lens = new THREE.MeshPhysicalMaterial({
  name: 'headlight',
  color: '#ffffff',
  emissive: '#eaf3ff',
  emissiveIntensity: 3,
  roughness: 0.05,
  clearcoat: 1,
});
const tailLens = new THREE.MeshStandardMaterial({
  name: 'taillight',
  color: '#3a0004',
  emissive: '#ff1426',
  emissiveIntensity: 2.4,
  roughness: 0.15,
});

/**
 * Deformações que tiram o aspecto de "bloco extrudado":
 * - afunila frente e traseira vistas de cima;
 * - inclina as laterais para dentro acima da linha de cintura (tumblehome).
 */
function sculpt(geo: THREE.BufferGeometry, { tumble = 0.16, beltline = 0.62, organic = true } = {}) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    let z = pos.getZ(i);
    if (organic) {
      const ends = Math.max(0, Math.abs(x) - 1.35) / (HALF - 1.35);
      z *= 1 - 0.2 * ends * ends;
      // lateral levemente abaulada
      z *= 1 + 0.03 * Math.sin(Math.min(1, Math.max(0, (y - SILL) / 0.7)) * Math.PI);
    }
    // tumblehome linear em y: mantém planas as tampas da extrusão
    if (y > beltline) z *= 1 - tumble * Math.min(1, (y - beltline) / 0.75);
    pos.setZ(i, z);
  }
}

/**
 * Normais suaves dentro de cada superfície, mas com vinco onde o ângulo entre
 * faces passa de ~35° (evita manchas onde a tampa encontra o chanfro).
 * Depois funde vértices iguais para voltar a uma malha indexada e leve.
 */
function smooth(geo: THREE.BufferGeometry) {
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  const creased = toCreasedNormals(geo, THREE.MathUtils.degToRad(35));
  return mergeVertices(creased, 1e-4);
}

function extrude(shape: THREE.Shape, depth: number, bevel: number, bevelSize = bevel * 0.8, segments = 8, tessellate = true) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize,
    bevelSegments: segments,
    curveSegments: 48,
    steps: 6,
  });
  geo.translate(0, 0, -(depth - bevel * 2) / 2);
  // As tampas laterais da extrusão só têm vértices no contorno; subdividimos
  // para que as deformações de sculpt() fiquem curvas, não triângulos longos.
  return tessellate ? new TessellateModifier(0.16, 10).modify(geo) : geo;
}

const car = new THREE.Group();
car.name = 'DemoCar';

// ── Carroceria ───────────────────────────────────────────────────────────────
const body = new THREE.Shape();
body.moveTo(-HALF + 0.12, SILL);
body.bezierCurveTo(-HALF - 0.02, SILL + 0.02, -HALF - 0.04, 0.42, -HALF - 0.01, 0.6);
body.bezierCurveTo(-HALF + 0.02, 0.8, -HALF + 0.1, 0.9, -HALF + 0.32, 0.92); // ducktail
body.lineTo(-1.55, 0.91);
body.lineTo(0.95, 0.9);
body.bezierCurveTo(1.55, 0.88, 1.95, 0.8, HALF - 0.12, 0.68); // capô
body.bezierCurveTo(HALF + 0.02, 0.62, HALF + 0.04, 0.42, HALF - 0.02, 0.3); // bico
body.lineTo(FRONT_AXLE + ARCH_R + 0.12, SILL);
body.absarc(FRONT_AXLE, SILL - 0.04, ARCH_R, 0, Math.PI, false);
body.lineTo(REAR_AXLE + ARCH_R, SILL);
body.absarc(REAR_AXLE, SILL - 0.04, ARCH_R, 0, Math.PI, false);
body.lineTo(-HALF + 0.12, SILL);

const bodyRaw = extrude(body, WIDTH, 0.13, 0.1, 10);
sculpt(bodyRaw);
const bodyMesh = new THREE.Mesh(smooth(bodyRaw), paint);
bodyMesh.name = 'Body';
car.add(bodyMesh);

// ── Cabine de vidro ──────────────────────────────────────────────────────────
const cabin = new THREE.Shape();
cabin.moveTo(-1.62, 0.86);
cabin.bezierCurveTo(-1.15, 1.02, -0.85, 1.24, -0.42, 1.29); // vidro traseiro fastback
cabin.lineTo(0.12, 1.3);
cabin.bezierCurveTo(0.42, 1.29, 0.72, 1.16, 1.02, 0.86); // para-brisa
cabin.lineTo(-1.62, 0.86);
const cabinRaw = extrude(cabin, 1.62, 0.1, 0.06, 8, false);
sculpt(cabinRaw, { tumble: 0.3, beltline: 0.86, organic: false });
// Teto panorâmico de vidro: a cabine inteira usa o material de vidro.
const glassMesh = new THREE.Mesh(smooth(cabinRaw), glass);
glassMesh.name = 'Glass';
car.add(glassMesh);

// ── Detalhes posicionados por raycast sobre a carroceria ─────────────────────
car.updateMatrixWorld(true);
const ray = new THREE.Raycaster();
function surface(target: THREE.Object3D, from: THREE.Vector3, dir: THREE.Vector3) {
  ray.set(from, dir.clone().normalize());
  const hit = ray.intersectObject(target, false)[0];
  if (!hit) throw new Error(`Raycast sem colisão a partir de ${from.toArray()}`);
  return { point: hit.point, normal: hit.face!.normal.clone() };
}

function placeOn(mesh: THREE.Mesh, target: THREE.Object3D, from: THREE.Vector3, dir: THREE.Vector3, sink = 0) {
  const { point, normal } = surface(target, from, dir);
  mesh.position.copy(point).addScaledVector(normal, -sink);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  car.add(mesh);
  return mesh;
}

for (const side of [-1, 1]) {
  // Faróis: lente alongada + moldura cromada
  const head = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.26, 8, 24), lens);
  head.geometry.rotateZ(Math.PI / 2 + side * 0.16);
  head.geometry.scale(1, 0.75, 0.55);
  placeOn(head, bodyMesh, new THREE.Vector3(4, 0.6, side * 0.6), new THREE.Vector3(-1, -0.05, 0), 0.015);

  // Lanternas: barra fina vermelha
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.055, 0.03), tailLens);
  placeOn(tail, bodyMesh, new THREE.Vector3(-4, 0.78, side * 0.5), new THREE.Vector3(1, 0, 0), 0.005);

  // Retrovisores
  const mirror = new THREE.Mesh(new THREE.SphereGeometry(0.075, 32, 16), paint);
  mirror.scale.set(1.5, 0.75, 1);
  placeOn(mirror, glassMesh, new THREE.Vector3(0.74, 0.97, side * 3), new THREE.Vector3(0, 0, -side), -0.07);

  // Coluna B escurecida sobre o vidro lateral
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.36, 0.02), trim);
  placeOn(pillar, glassMesh, new THREE.Vector3(-0.38, 1.08, side * 3), new THREE.Vector3(0, 0, -side), 0);

  // Maçaneta embutida
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.012), chrome);
  placeOn(handle, bodyMesh, new THREE.Vector3(-0.1, 0.8, side * 3), new THREE.Vector3(0, 0, -side), 0);

  // Saia lateral
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.07, 0.04), trim);
  skirt.position.set(0.05, SILL + 0.035, side * (WIDTH / 2 - 0.02));
  car.add(skirt);

  // Ponteiras de escapamento
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.14, 32, 1, true), chrome);
  tip.rotation.z = Math.PI / 2;
  tip.position.set(-HALF - 0.04, 0.3, side * 0.42);
  car.add(tip);
}

const lightBar = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.022, 0.02), tailLens);
placeOn(lightBar, bodyMesh, new THREE.Vector3(-4, 0.78, 0), new THREE.Vector3(1, 0, 0), 0.004);

const grille = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.15, 0.06), trim);
placeOn(grille, bodyMesh, new THREE.Vector3(4, 0.4, 0), new THREE.Vector3(-1, 0, 0), 0.02);

const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 1.6), trim);
splitter.position.set(HALF - 0.05, SILL + 0.01, 0);
car.add(splitter);

const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 1.3), trim);
diffuser.position.set(-HALF + 0.06, SILL + 0.04, 0);
car.add(diffuser);

// ── Rodas ───────────────────────────────────────────────────────────────────
function tireGeometry() {
  const pts: THREE.Vector2[] = [];
  const w = 0.13;
  const inner = 0.25;
  const corner = 0.055;
  pts.push(new THREE.Vector2(inner, -w));
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * (Math.PI / 2);
    pts.push(new THREE.Vector2(WHEEL_R - corner + Math.cos(a) * corner, -w + corner + Math.sin(a) * corner));
  }
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    pts.push(new THREE.Vector2(WHEEL_R - corner + Math.cos(a) * corner, w - corner + Math.sin(a) * corner));
  }
  pts.push(new THREE.Vector2(inner, w));
  const g = new THREE.LatheGeometry(pts, 72);
  g.rotateX(Math.PI / 2);
  return g;
}

function wheel(x: number, side: number) {
  const g = new THREE.Group();
  g.name = `Wheel${x > 0 ? 'Front' : 'Rear'}${side > 0 ? 'Left' : 'Right'}`;
  g.add(new THREE.Mesh(tireGeometry(), tireMat));

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.25, 64, 1, true), trim);
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.022, 48), brake);
  disc.rotation.x = Math.PI / 2;
  disc.position.z = side * 0.02;
  g.add(disc);
  const cal = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.16, 0.05), caliper);
  cal.position.set(x > 0 ? -0.14 : 0.14, 0.06, side * 0.045);
  g.add(cal);

  const face = new THREE.Group();
  face.position.z = side * 0.105;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.04, 32), chrome);
  hub.rotation.x = Math.PI / 2;
  face.add(hub);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.243, 0.012, 16, 96), rimMat);
  face.add(lip);
  for (let i = 0; i < 10; i++) {
    // 5 raios duplos
    const a = (Math.floor(i / 2) / 5) * Math.PI * 2 + (i % 2 ? 0.09 : -0.09);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.2, 0.028), rimMat);
    spoke.position.set(Math.sin(a) * 0.14, Math.cos(a) * 0.14, 0);
    spoke.rotation.z = -a;
    face.add(spoke);
  }
  g.add(face);
  g.position.set(x, WHEEL_R, side * TRACK);
  return g;
}
for (const x of [FRONT_AXLE, REAR_AXLE]) for (const side of [-1, 1]) car.add(wheel(x, side));

// ── Exportação ──────────────────────────────────────────────────────────────
car.rotation.y = -Math.PI / 2;
const scene = new THREE.Scene();
scene.add(car);
const out = fileURLToPath(new URL('../server/assets/demo-car.glb', import.meta.url));
const exporter = new GLTFExporter();
const glb = (await exporter.parseAsync(scene, { binary: true })) as ArrayBuffer;
await writeFile(out, Buffer.from(glb));
console.log(`Gerado ${out} (${(glb.byteLength / 1024).toFixed(0)} KB)`);
