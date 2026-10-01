import { serve } from '@hono/node-server';
import { bootstrap } from './app.ts';
import { env } from './lib/env.ts';
import { tick } from './domain/automations.ts';
import { loadCtx } from './domain/context.ts';

const app = await bootstrap();

serve({ fetch: app.fetch, port: env.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`\n  Z.YASS platform API  →  http://localhost:${info.port}`);
  console.log(`  demo=${env.demo}  db=${env.databaseUrl ? 'postgres' : 'sqlite:' + env.dataFile}  tz=${env.tz}\n`);
});

// En local : horloge intégrée (le serveur serverless utilise Vercel Cron sur /api/internal/cron).
if (!env.isProd) {
  const every = Number(process.env.TICK_EVERY_SEC || 60);
  setInterval(async () => {
    try {
      const ctx = await loadCtx();
      const r = await tick({ ctx, full: true });
      if (r.dispatched || r.noShows || r.rebook || r.expiredOffers) console.log(`[tick] ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.error('[tick]', e?.message);
    }
  }, every * 1000).unref();
}

export default app;
