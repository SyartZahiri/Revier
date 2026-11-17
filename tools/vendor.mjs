// Copies the few three.js files the game needs from node_modules into public/vendor,
// so public/ is a complete website on its own (needed for GitHub Pages). Runs after "npm install".
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const three = path.join(root, 'node_modules', 'three');
const out = path.join(root, 'public', 'vendor');
const files = [
  ['build/three.module.js', 'three.module.js'],
  ['build/three.core.js', 'three.core.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'addons/loaders/GLTFLoader.js'],
  ['examples/jsm/loaders/HDRLoader.js', 'addons/loaders/HDRLoader.js'],
  ['examples/jsm/utils/SkeletonUtils.js', 'addons/utils/SkeletonUtils.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'addons/utils/BufferGeometryUtils.js'],
];
for (const [from, to] of files) {
  await mkdir(path.dirname(path.join(out, to)), { recursive: true });
  await cp(path.join(three, from), path.join(out, to));
}
console.log(`three.js: ${files.length} Dateien nach public/vendor kopiert`);
