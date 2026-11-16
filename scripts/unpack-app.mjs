// Restores the readable source: node scripts/unpack-app.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const read = async (path) => {
  const packed = await readFile(path, 'utf8');
  const base64 = packed.match(/"([A-Za-z0-9+/=]*)"/)?.[1];
  if (!base64) throw new Error(`${path} does not contain a base64 string`);
  return base64;
};

const base64 = (await read('app.payload.a.js')) + (await read('app.payload.b.js'));
const source = gunzipSync(Buffer.from(base64, 'base64'));
await writeFile('app.src.js', source);
console.log(`wrote app.src.js (${source.length} bytes)`);
