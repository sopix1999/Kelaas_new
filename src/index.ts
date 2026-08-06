// ============================================================
// KELAAS — Cloudflare Worker entry
// Semua routing ada di src/app.ts (Hono app).
// ============================================================
import { app } from './app';

export default app;

// Cron trigger: finalisasi sesi CBT kadaluarsa (mirip trigger GAS 5 menit).
// Set di dashboard Cloudflare: Triggers → Cron Triggers → */5 * * * *
const scheduled = async (event: ScheduledEvent, env: any, ctx: ExecutionContext) => {
  try {
    const req = new Request('https://internal/api?action=cbt-cleanup-expired', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const fetchFn = app.fetch as (req: Request, env: unknown, executionCtx: unknown) => Promise<Response>;
    const res = await fetchFn(req, env, ctx);
    if (!res.ok) console.error('cbt-cleanup-expired cron failed:', res.status);
  } catch (e) {
    console.error('cbt-cleanup-expired cron error:', e);
  }
};

export { scheduled };
