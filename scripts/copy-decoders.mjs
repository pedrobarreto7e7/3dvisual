// Copia o decodificador Draco do three.js para public/draco, para que modelos
// comprimidos carreguem sem depender de CDN externa.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../node_modules/three/examples/jsm/libs/draco/gltf/', import.meta.url));
const dest = fileURLToPath(new URL('../public/draco/', import.meta.url));
if (existsSync(src)) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}
