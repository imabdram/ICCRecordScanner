// Minimal static server for dist/, used only to smoke-test the built site.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = process.argv[2] ?? 'dist';
const port = Number(process.argv[3] ?? 4180);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const path = join(root, url === '/' ? 'index.html' : url);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}).listen(port, () => console.log('serving', root, 'on', port));
