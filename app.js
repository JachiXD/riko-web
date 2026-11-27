// index.html loads this file, which simply brings in the app module.
//
// Her app used to be shipped as a gzip + base64 payload split across two files,
// because the repository's old write path truncated anything over about 17 KB.
// That path is gone, so the real module is served as itself: readable in the
// repository, cache-busted by the version on the import below.
import './app.src.js?v=32';
