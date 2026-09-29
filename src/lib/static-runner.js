import { getContainer, stopActiveRun, trackRun, clearContainerFs } from './runner.js';

// A dependency-free static file server, written into the WebContainer and run
// with plain `node` — no npm install needed. Serves index.html (or the first
// .html page) and falls back to a browsable listing with the README.
const SERVER_FILE = '.repo-runner-static.mjs';
const SERVER_SOURCE = String.raw`
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] || '.');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function listing(dir, urlPath) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.git' && e.name !== '${SERVER_FILE}')
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const base = urlPath.endsWith('/') ? urlPath : urlPath + '/';
  const rows = entries.map((e) => '<li><a href="' + base + encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '') + '">' +
    (e.isDirectory() ? '📁 ' : '📄 ') + esc(e.name) + (e.isDirectory() ? '/' : '') + '</a></li>').join('');
  const readme = entries.find((e) => /^readme(\.md|\.txt)?$/i.test(e.name));
  const readmeText = readme ? readFileSync(join(dir, readme.name), 'utf8').slice(0, 20000) : '';
  return '<!doctype html><meta charset="utf-8"><title>' + esc(urlPath) + '</title>' +
    '<style>body{font:14px/1.55 system-ui,sans-serif;margin:0;padding:28px;background:#0d1117;color:#e6edf3}' +
    'a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}' +
    'ul{list-style:none;padding:0;margin:0 0 24px;border:1px solid #30363d;border-radius:10px;overflow:hidden}' +
    'li{padding:9px 14px;border-top:1px solid #21262d}li:first-child{border-top:0}h1{font-size:15px;font-weight:600;color:#8b949e}' +
    'pre{white-space:pre-wrap;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px;font:13px/1.6 ui-monospace,monospace}</style>' +
    '<h1>' + esc(urlPath) + '</h1><ul>' + (urlPath !== '/' ? '<li><a href="../">⬆ ..</a></li>' : '') + rows + '</ul>' +
    (readmeText ? '<pre>' + esc(readmeText) + '</pre>' : '');
}

createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  const target = resolve(root, '.' + urlPath);
  if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  if (!existsSync(target)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  if (statSync(target).isDirectory()) {
    if (!urlPath.endsWith('/')) { res.writeHead(301, { Location: urlPath + '/' }).end(); return; }
    const index = join(target, 'index.html');
    if (existsSync(index)) { res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(readFileSync(index)); return; }
    res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(listing(target, urlPath));
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
  res.end(readFileSync(target));
}).listen(3000, () => console.log('Serving on http://localhost:3000'));
`;

/** Pick the landing page: index.html, else home/main.html, else the first .html. */
function landingPage(tree) {
  const html = Object.keys(tree).filter((n) => n.toLowerCase().endsWith('.html') && tree[n].file);
  if (html.includes('index.html')) return null;
  return html.find((f) => /^(home|main)\.html$/i.test(f)) || html[0] || null;
}

/**
 * Serve a static site (or a file listing) from the in-browser WebContainer.
 * Calls onServerReady(url) once the server is up.
 */
export async function runStaticSite({ tree, onOutput, onServerReady }) {
  const container = await getContainer();
  stopActiveRun();
  await clearContainerFs(container);
  onOutput('Mounting files into the in-browser sandbox...\n');
  const page = landingPage(tree);
  const files = { ...tree, [SERVER_FILE]: { file: { contents: SERVER_SOURCE } } };
  if (page) {
    files['index.html'] = tree[page];
    onOutput(`Using ${page} as the home page.\n`);
  }
  await container.mount(files);

  trackRun({ unsubscribe: container.on('server-ready', (port, url) => onServerReady(url, port)) });
  const proc = await container.spawn('node', [SERVER_FILE, '.']);
  trackRun({ process: proc });
  proc.output.pipeTo(new WritableStream({ write: (chunk) => onOutput(chunk) })).catch(() => {});
  return { container, process: proc };
}
