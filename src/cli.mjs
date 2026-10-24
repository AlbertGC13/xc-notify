import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const help = 'Local mock only: node src/cli.mjs serve|demo|--help\n' +
  'Required: MOCK_SIGNING_SECRET=demo-only-<16+ characters>, SHOP_DOMAIN=<shop>.myshopify.com\n' +
  'Optional: DATABASE_PATH=./mock.sqlite, HOST=127.0.0.1, PORT=3000, TRANSPORT=mock\n' +
  'Mock controls: MOCK_DISPATCH=active|paused, MOCK_RETRY_MS=100 (10..60000)\n' +
  'Local Meta prototype: node src/cli.mjs receive-meta\n' +
  'Required: META_VERIFY_TOKEN, META_APP_SECRET=demo-only-<16..120 ASCII letters/digits/_/->\n' +
  'Optional: META_HOST=127.0.0.1 (or ::1), META_PORT=3001 (0..65535)\n' +
  'ACK-only synthetic prototype: NEVER REGISTER FOR REAL EVENTS; no durability, dedup or sends.\n';
function configuration(env) {
  const config = {
    secret: env.MOCK_SIGNING_SECRET, shop: env.SHOP_DOMAIN,
    database: resolve(env.DATABASE_PATH || './mock.sqlite'), host: env.HOST ?? '127.0.0.1',
    port: env.PORT ?? '3000', transport: env.TRANSPORT ?? 'mock',
    dispatch: env.MOCK_DISPATCH ?? 'active', retryMs: env.MOCK_RETRY_MS ?? '100'
  };
  if (!/^demo-only-[A-Za-z0-9_-]{16,120}$/.test(config.secret ?? '') ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(config.shop ?? '') || config.shop.length > 255 ||
      !['127.0.0.1', '::1'].includes(config.host) || config.transport !== 'mock' ||
      !['active', 'paused'].includes(config.dispatch) || !/^\d{1,5}$/.test(config.port) || Number(config.port) > 65535 ||
      !/^\d{1,5}$/.test(config.retryMs) || Number(config.retryMs) < 10 || Number(config.retryMs) > 60000) {
    throw new Error('Configuration error. Run --help.');
  }
  return { ...config, port: Number(config.port), retryMs: Number(config.retryMs) };
}
async function demo(config, start) {
  const directory = await mkdtemp(join(resolve(import.meta.dirname, '..'), '.demo-session-'));
  let app;
  try {
    app = await start({ ...config, port: 0, database: join(directory, 'queue.sqlite'), dispatch: 'active' });
    const host = config.host === '::1' ? '[::1]' : config.host;
    const base = `http://${host}:${app.port}`;
    const body = await readFile(new URL('../fixtures/order.json', import.meta.url));
    const headers = { 'content-type': 'application/json', 'x-shopify-shop-domain': config.shop,
      'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': 'demo-delivery',
      'x-shopify-hmac-sha256': createHmac('sha256', config.secret).update(body).digest('base64') };
    for (const [code, status] of [[202, 'accepted'], [200, 'duplicate']]) {
      const response = await fetch(`${base}/webhooks/orders/create`, { method: 'POST', body, headers });
      if (response.status !== code || JSON.stringify(await response.json()) !== JSON.stringify({ status })) {
        throw new Error('demo_failed');
      }
    }
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(`${base}/mock/state`)).json();
      if (state.deliveries.length === 1 && state.counts.attempts === 1) {
        process.stdout.write(`mock demo: accepted=202 replay=200 deliveries=1\n${state.deliveries[0].message}\n`);
        return;
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    throw new Error('demo_failed');
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const command = process.argv[2];
try {
  if (process.argv.length !== 3 || !['serve', 'demo', '--help', 'receive-meta'].includes(command)) {
    throw new Error('Unknown command. Run --help.');
  }
  if (command === '--help') process.stdout.write(help);
  else {
    // Dispatch Meta before mock configuration or any SQLite/server import.
    const meta = command === 'receive-meta' ? await import('./meta-receiver.mjs') : null;
    const config = meta ? meta.configuration(process.env) : configuration(process.env);
    const { start } = meta ?? await import('./server.mjs');
    if (command === 'demo') await demo(config, start);
    else {
      const app = await start(config);
      process.stdout.write(`${JSON.stringify({ listening: app.port })}\n`);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        process.stdin.pause();
        await app.close();
      };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      // Public local lifecycle control, portable to Windows (where SIGTERM is not graceful).
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { if (chunk.trim() === 'stop') void stop(); });
    }
  }
} catch (error) {
  const known = ['Configuration error. Run --help.', 'Unknown command. Run --help.'];
  const failure = command === 'receive-meta' ? 'Local Meta receiver failed.' :
    'Local mock failed; check database access and port availability.';
  process.stderr.write(`${known.includes(error.message) ? error.message : failure}\n`);
  process.exitCode = 1;
}
