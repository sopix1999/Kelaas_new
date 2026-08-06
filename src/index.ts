// ============================================================
// KELAAS — Cloudflare Worker entry (Hono)
// Menggabungkan:
//  1) API REST  (port index.php):   GET/POST/PUT/DELETE /api?action=...
//  2) Bridge GAS (port code.gs):    POST /__gas {fn, args} — emulasi
//                                   google.script.run untuk index.html lama
//  3) Static assets (index.html)    via binding ASSETS
// ============================================================
import { Hono } from 'hono';
import { registerRoutes } from './api/routes';
import { handleBridge } from './api-bridge';

type Bindings = {
  DB: any;
  GEMINI_KEY?: string;
  GEMINI_MODEL?: string;
  ASSETS: any;
};

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
  console.error('[hono-error]', err && err.stack ? err.stack : String(err));
  return new Response(JSON.stringify({ success: false, message: 'Error: ' + (err instanceof Error ? err.message : String(err)) }), {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
});

// Service worker binding agar bridge bisa memanggil route /api internal
// (selalu mengarah ke worker sendiri).
app.use('*', async (c, next) => {
  const env = c.env as Record<string, any>;
  if (!env.self) {
    env.self = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
        const base = new URL(c.req.url);
        const target = new URL(url.pathname + url.search, base.origin);
        return fetch(target.toString(), init);
      },
    };
  }
  await next();
});

// ---- API REST ----
await registerRoutes(app);

// ---- Bridge GAS (emulasi google.script.run) ----
app.post('/__gas', async (c) => handleBridge(c));

// ---- Static assets / SPA fallback ----
app.all('*', async (c) => {
  const env = c.env as Record<string, any>;
  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    const url = new URL(c.req.url);
    // Redirect root ke index.html
    if (url.pathname === '/' || url.pathname === '/index.html') {
      url.pathname = '/index.html';
      const r = await env.ASSETS.fetch(url.toString(), c.req.raw);
      if (r.ok) return new Response(r.body, r);
    }
    const r = await env.ASSETS.fetch(c.req.url, c.req.raw);
    if (r.ok) return r;
    // SPA fallback untuk route client-side
    const idx = new URL('/index.html', c.req.url);
    const r2 = await env.ASSETS.fetch(idx.toString(), c.req.raw);
    if (r2.ok) return new Response(r2.body, r2);
  }
  return new Response('Not Found', { status: 404 });
});

// Cron trigger: finalisasi sesi CBT kadaluarsa (mirip trigger GAS 5 menit).
// Set di dashboard Cloudflare: Triggers → Cron Triggers → */5 * * * *
const scheduled = async (event: ScheduledEvent, env: any, ctx: ExecutionContext) => {
  const url = 'https://internal/api?action=cbt-cleanup-expired';
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  // Route internal tanpa network: buat request buatan ke worker sendiri.
  try {
    const req = new Request(url, init);
    const res = await app.fetch(req, env, ctx);
    if (!res.ok) console.error('cbt-cleanup-expired cron failed:', res.status);
  } catch (e) {
    console.error('cbt-cleanup-expired cron error:', e);
  }
};

export { scheduled };
export default app;
