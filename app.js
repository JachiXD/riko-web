// index.html loads this file. Her actual app code is in app.payload.a.js and
// app.payload.b.js, as one gzip + base64 string split in two, because the only
// write path into this repository truncates files larger than about 17 KB and
// had begun mangling characters. This wrapper restores the real module byte for
// byte and imports it.
//
// To read or edit the real source, run:  node scripts/unpack-app.mjs
// That writes app.src.js. After editing it, repack with:
//   node scripts/pack-app.mjs
//
// Nothing below changes behaviour: the imported module is the same module the
// page used to load directly, just delivered through a smaller envelope.

const [head, tail] = await Promise.all([
  import('./app.payload.a.js?v=30'),
  import('./app.payload.b.js?v=30'),
]);
const gzip = head.default + tail.default;

const bytes = Uint8Array.from(atob(gzip), (c) => c.charCodeAt(0));
const source = await new Response(
  new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
).text();

// A blob URL has no directory, so relative imports inside the module would not
// resolve. Point them at the page's own directory before importing.
const base = new URL('.', import.meta.url);
const resolved = source.replace(
  /(\bfrom\s*|\bimport\s*)(['"])\.\/([^'"]*)\2/g,
  (_match, keyword, quote, path) => `${keyword}${quote}${new URL(path, base).href}${quote}`,
);

await import(URL.createObjectURL(new Blob([resolved], { type: 'text/javascript' })));
