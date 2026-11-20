// Tiny zero-dependency server for the bundled demo app: static pages + a small JSON API (for API test examples).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.join(import.meta.dirname, 'public');
const port = Number(process.env.DEMO_PORT ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// ---------------------------------------------------------------- demo API (in memory; resets on restart)
const PRODUCTS = [
  { sku: 'backpack', name: 'Backpack', price: 29.99 },
  { sku: 'bike-light', name: 'Bike Light', price: 9.99 },
  { sku: 'bolt-tshirt', name: 'Bolt T-Shirt', price: 15.99 },
];
const TOKENS = new Map(); // token → username
const ORDERS = new Map();
const USERS = new Set(['standard_user', 'problem_user', 'performance_glitch_user']);
const PASSWORD = 'secret_sauce';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readJson = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > 100_000) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(undefined); } });
});

async function api(req, res, url) {
  if (url.pathname === '/api/products' && req.method === 'GET') return json(res, 200, { items: PRODUCTS, count: PRODUCTS.length });
  const product = /^\/api\/products\/([\w-]+)$/.exec(url.pathname);
  if (product && req.method === 'GET') {
    const p = PRODUCTS.find((x) => x.sku === product[1]);
    return p ? json(res, 200, p) : json(res, 404, { error: 'not_found' });
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: 'invalid_json' });
    const errors = [];
    if (!body.username) errors.push({ field: 'username', message: 'required' });
    if (!body.password) errors.push({ field: 'password', message: 'required' });
    if (errors.length) return json(res, 422, { errors });
    if (!USERS.has(body.username) || body.password !== PASSWORD) return json(res, 401, { error: 'invalid_credentials' });
    const token = crypto.randomBytes(16).toString('hex');
    TOKENS.set(token, body.username);
    return json(res, 200, { token, user: body.username });
  }
  const user = TOKENS.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (url.pathname === '/api/orders' && req.method === 'POST') {
    if (!user) return json(res, 401, { error: 'unauthorized' });
    const body = await readJson(req);
    const p = PRODUCTS.find((x) => x.sku === body?.sku);
    const qty = Number(body?.qty);
    const errors = [];
    if (!p) errors.push({ field: 'sku', message: 'unknown product' });
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) errors.push({ field: 'qty', message: 'must be 1 to 10' });
    if (errors.length) return json(res, 422, { errors });
    const order = { id: `ORD-${ORDERS.size + 1001}`, user, sku: p.sku, qty, total: Math.round(p.price * qty * 100) / 100, status: 'NEW' };
    ORDERS.set(order.id, order);
    res.setHeader('Location', `/api/orders/${order.id}`);
    return json(res, 201, order);
  }
  const order = /^\/api\/orders\/([\w-]+)$/.exec(url.pathname);
  if (order && req.method === 'GET') {
    if (!user) return json(res, 401, { error: 'unauthorized' });
    const o = ORDERS.get(order[1]);
    return o && o.user === user ? json(res, 200, o) : json(res, 404, { error: 'not_found' });
  }
  return json(res, 404, { error: 'not_found' });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch(() => json(res, 500, { error: 'server_error' }));
      return;
    }
    let file = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`Demo app on http://localhost:${port} (API under /api)`));
