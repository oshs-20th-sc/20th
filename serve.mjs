import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const base = resolve(root);
const port = Number(process.argv[2] || 5176);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('포트는 1~65535 정수로 입력하세요.');
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.split(/[\\/]/).some((part) => part.startsWith('.'))) {
      response.writeHead(403);
      response.end();
      return;
    }
    let file = resolve(base, '.' + pathname);
    if (file !== base && !file.startsWith(base + sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(404, { 'Content-Type': types['.html'] });
      response.end(
        request.method === 'HEAD' ? undefined : await readFile(resolve(base, '404.html')),
      );
      return;
    }
    if ((await stat(file)).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(301, { Location: url.pathname + '/' + url.search });
        response.end();
        return;
      }
      file = resolve(file, 'index.html');
    }
    const actualFile = await realpath(file);
    if (actualFile !== base && !actualFile.startsWith(base + sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const contents = await readFile(actualFile);
    response.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': contents.length,
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch {
    response.writeHead(404);
    response.end(request.method === 'HEAD' ? undefined : '404');
  }
}).listen(port, '127.0.0.1', () => process.stdout.write(`http://127.0.0.1:${port}\n`));
