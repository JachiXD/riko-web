// Repacks after editing app.src.js: node scripts/pack-app.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const source = await readFile('app.src.js');
const base64 = gzipSync(source, { level: 9 }).toString('base64');
const half = Math.floor(base64.length / 2);

await writeFile('app.payload.a.js', `export default "${base64.slice(0, half)}";\n`);
await writeFile('app.payload.b.js', `export default "${base64.slice(half)}";\n`);
console.log(`app.src.js ${source.length} bytes -> ${base64.length} base64 chars in two parts`);
