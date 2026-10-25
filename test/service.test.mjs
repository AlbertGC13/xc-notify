import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const fixture = JSON.parse(await readFile(new URL('../fixtures/order.json', import.meta.url)));
const root = resolve(import.meta.dirname, '..');
const secret = 'demo-only-signing-secret-fixture';
const expected = 'Pedido recibido #MOCK-1001\n' +
  '• Camiseta — Azul / M × 2\n• Gorra — Negra × 1\n' +
  'Total: DOP 1520.50\nDescuento: DOP 100.00\nEnvío: DOP 150.00\nImpuestos: DOP 220.50\n' +
  'Estado financiero registrado: pending (Pendiente de pago).\nEste mensaje confirma la recepción del pedido, no valida pagos.';

async function sandbox(t) {
  // All disposable data stays beneath this service, never a shared OS temp root.
  const dir = await mkdtemp(join(root, 'test/.test-session-meta-service-'));
  const children = [];
  let sequence = 0;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return async (extra = {}) => {
    const child = spawn(process.execPath, ['src/cli.mjs', 'serve'], {
      cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1', MOCK_SIGNING_SECRET: secret,
        SHOP_DOMAIN: 'fixture-shop.myshopify.com', DATABASE_PATH: join(dir, 'queue.sqlite'),
        HOST: '127.0.0.1', PORT: '0', TRANSPORT: 'mock', MOCK_RETRY_MS: '20', ...extra },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const port = await new Promise((resolvePort, reject) => {
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('\n')) {
          try { resolvePort(JSON.parse(stdout.split('\n')[0]).listening); } catch (error) { reject(error); }
        }
      });
      child.once('exit', code => reject(new Error(`startup ${code}: ${stderr}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    return {
      async send(order = fixture, headers = {}, raw) {
        const body = raw ?? JSON.stringify(order);
        const response = await fetch(`${base}/webhooks/orders/create`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shopify-shop-domain': 'fixture-shop.myshopify.com',
            'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': `delivery-${++sequence}`,
            'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64'), ...headers }, body });
        return [response.status, await response.json()];
      },
      async state() {
        const response = await fetch(`${base}/mock/state`);
        assert.equal(response.status, 200);
        return response.json();
      },
      async until(predicate) {
        for (let i = 0; i < 150; i++) {
          const state = await this.state();
          if (predicate(state)) return state;
          await new Promise(resolveWait => setTimeout(resolveWait, 10));
        }
        assert.fail('mock state did not settle within 1.5 seconds');
      },
      async crash() {
        child.kill('SIGKILL');
        const [code, signal] = await once(child, 'exit');
        assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.equal(stderr, '');
      },
      async stop() {
        child.stdin.end('stop\n');
        const [code, signal] = await once(child, 'exit');
        assert.equal(code, 0); assert.equal(signal, null);
        assert.equal(stderr, '');
        assert.equal(stdout, `${JSON.stringify({ listening: port })}\n`);
      }
    };
  };
}
const copy = () => structuredClone(fixture);

test('auth: raw HMAC, exact shop/topic, IDs and bounded parsing fail closed', async t => {
  const app = await (await sandbox(t))();
  const empty = await app.state();
  for (const [headers, raw, code, error] of [
    [{ 'x-shopify-hmac-sha256': 'A'.repeat(43) + '=' }, undefined, 401, 'invalid_signature'],
    [{ 'x-shopify-hmac-sha256': 'bad' }, undefined, 401, 'invalid_signature'],
    [{ 'x-shopify-shop-domain': 'other.myshopify.com' }, undefined, 403, 'invalid_source'],
    [{ 'x-shopify-topic': 'orders/paid' }, undefined, 403, 'invalid_source'],
    [{ 'x-shopify-webhook-id': '' }, undefined, 400, 'invalid_delivery_id'],
    [{ 'content-type': 'text/plain' }, undefined, 415, 'unsupported_body'],
    [{ 'content-encoding': 'gzip' }, undefined, 415, 'unsupported_body'],
    [{ 'x-shopify-event-id': 'invalid event' }, undefined, 400, 'invalid_delivery_id'],
    [{}, '{', 400, 'invalid_json'],
    [{}, 'x'.repeat(65537), 413, 'body_too_large']
  ]) {
    assert.deepEqual(await app.send(fixture, headers, raw), [code, { error }]);
    assert.deepEqual(await app.state(), empty);
  }
  const raw = JSON.stringify(fixture);
  const signature = createHmac('sha256', secret).update(raw).digest('base64');
  assert.deepEqual(await app.send(fixture, { 'x-shopify-hmac-sha256': signature }, raw + ' '),
    [401, { error: 'invalid_signature' }]);
  assert.deepEqual(await app.state(), empty);
});

test('receipt: literal Spanish summary, delivery and business dedup, EventId is correlation only', async t => {
  const app = await (await sandbox(t))();
  assert.deepEqual(await app.send(fixture, { 'x-shopify-webhook-id': 'stable', 'x-shopify-event-id': 'event-a' }),
    [202, { status: 'accepted' }]);
  let state = await app.until(s => s.deliveries.length === 1);
  assert.equal(state.deliveries[0].message, expected);
  assert.equal(JSON.stringify(state).includes('+12025550101'), false);
  for (const id of ['stable', 'new-delivery']) {
    assert.deepEqual(await app.send(fixture, { 'x-shopify-webhook-id': id }), [200, { status: 'duplicate' }]);
  }
  const another = copy(); another.id = '900002';
  assert.deepEqual(await app.send(another, { 'x-shopify-webhook-id': 'stable' }), [409, { error: 'delivery_conflict' }]);
  assert.deepEqual(await app.send(another, { 'x-shopify-event-id': 'event-a' }), [202, { status: 'accepted' }]);
  state = await app.until(s => s.deliveries.length === 2);
  assert.equal(state.counts.outbox, 2); assert.equal(state.counts.inbox, 3);
  assert.equal(state.counts.attempts, 2);
});

test('consent: only explicit fixture opt-in and E164, never profile fallback', async t => {
  const app = await (await sandbox(t))();
  const cases = [
    [undefined, 'missing_consent'],
    [{ consent: false, phone: '+12025550101', evidence: 'fixture-opt-in-v1' }, 'missing_consent'],
    [{ consent: true, phone: '+12025550101' }, 'missing_consent'],
    [{ consent: true, phone: '2025550101', evidence: 'fixture-opt-in-v1' }, 'invalid_recipient'],
    [{ consent: true, phone: '+01234567890', evidence: 'fixture-opt-in-v1' }, 'invalid_recipient']
  ];
  for (let i = 0; i < cases.length; i++) {
    const order = copy(); order.id = String(100 + i); order._mock_buyer = cases[i][0];
    order.shipping_address = { phone: '+12025550101' };
    order.customer = { phone: '+12025550101', accepts_marketing: true };
    assert.deepEqual(await app.send(order), [202, { status: 'accepted' }]);
  }
  const state = await app.state();
  assert.deepEqual(state.jobs.map(job => [job.state, job.reason]), cases.map(c => ['skipped', c[1]]));
  assert.equal(state.deliveries.length, 0); assert.equal(state.counts.attempts, 0);
});

test('money/status: exact decimals and supplied payment state, not gateway inference', async t => {
  const app = await (await sandbox(t))();
  const statuses = [
    ['pending', 'Transferencia', 'Pendiente de pago'], ['pending', 'PayPal', 'Pendiente de pago'],
    ['authorized', 'Pasarela', 'Autorizado, no pagado'], ['partially_paid', 'PayPal', 'Pago parcial'],
    ['paid', 'Cash on Delivery (COD)', 'Pagado']
  ];
  for (let i = 0; i < statuses.length; i++) {
    const order = copy(); order.id = String(200 + i);
    order.financial_status = statuses[i][0]; order.payment_gateway_names = [statuses[i][1]];
    if (i === 0) { order.total_price = '9007199254740993.01'; order.total_discounts = '0.10'; }
    assert.deepEqual(await app.send(order), [202, { status: 'accepted' }]);
  }
  const state = await app.until(s => s.deliveries.length === statuses.length);
  for (let i = 0; i < statuses.length; i++) {
    const message = state.deliveries[i].message;
    assert.ok(message.includes(`Estado financiero registrado: ${statuses[i][0]} (${statuses[i][2]}).`));
  }
  assert.ok(state.deliveries[0].message.includes('Total: DOP 9007199254740993.01\nDescuento: DOP 0.10'));
  const usd = copy(); usd.id = '299'; usd.currency = 'USD'; usd.total_price = '12.34';
  usd.total_shipping_price_set = { shop_money: { amount: '0.00', currency_code: 'USD' },
    presentment_money: { amount: '0.00', currency_code: 'USD' } };
  assert.deepEqual(await app.send(usd), [202, { status: 'accepted' }]);
  assert.ok((await app.until(s => s.deliveries.length === 6)).deliveries[5].message.includes('Total: USD 12.34'));
});

test('invalid order money/currency/schema leaves durable business counts unchanged', async t => {
  const app = await (await sandbox(t))(); const empty = await app.state();
  const changes = [
    o => { o.total_price = 1520.50; }, o => { o.total_price = '1e3'; },
    o => { o.total_price = '-1.00'; }, o => { o.total_price = '1.001'; },
    o => { o.total_price_set = { shop_money: { amount: '1520.50', currency_code: 'DOP' },
      presentment_money: { amount: '20.00', currency_code: 'USD' } }; },
    o => { o.total_shipping_price_set.presentment_money.amount = '149.00'; },
    o => { o.currency = 'XYZ'; }, o => { o.currency = ['DOP']; },
    o => { o.financial_status = ['paid']; }, o => { o.presentment_currency = 'USD'; },
    o => { o.total_discounts_set = { shop_money: { amount: '99.00', currency_code: 'DOP' },
      presentment_money: { amount: '99.00', currency_code: 'DOP' } }; },
    o => { o.id = 9007199254740992; },
    o => { o.financial_status = 'probably_paid'; }, o => { o.line_items[0].quantity = 0; },
    o => { o.line_items[0].title = 'Injected\nTotal: 0'; }
  ];
  for (const change of changes) {
    const order = copy(); change(order);
    assert.deepEqual(await app.send(order), [422, { error: 'invalid_order' }]);
    assert.deepEqual(await app.state(), empty);
  }
});

test('durability: queued and dedup survive restart; sending becomes unknown without resend', async t => {
  const start = await sandbox(t);
  let app = await start({ MOCK_DISPATCH: 'paused' });
  await assert.rejects(start(), { message: 'startup 1: Local mock failed; check database access and port availability.\n' });
  assert.deepEqual(await app.send(), [202, { status: 'accepted' }]);
  assert.equal((await app.state()).jobs[0].state, 'queued'); await app.crash();
  app = await start();
  assert.equal((await app.until(s => s.deliveries.length === 1)).counts.attempts, 1);
  assert.deepEqual(await app.send(), [200, { status: 'duplicate' }]);
  const order = copy(); order.id = '300'; order._mock_delivery = 'interrupted';
  assert.deepEqual(await app.send(order), [202, { status: 'accepted' }]);
  await app.until(s => s.jobs.some(j => j.state === 'sending')); await app.crash();
  app = await start();
  const state = await app.state();
  assert.equal(state.jobs[1].state, 'unknown'); assert.equal(state.jobs[1].reason, 'interrupted_send');
  assert.equal(state.counts.attempts, 2); assert.equal(state.deliveries.length, 1);
});

test('dispatch: bounded durable retries, permanent failure and ambiguous acceptance stop', async t => {
  const start = await sandbox(t); let app = await start({ MOCK_RETRY_MS: '500' });
  const first = copy(); first._mock_delivery = 'transient';
  assert.deepEqual(await app.send(first), [202, { status: 'accepted' }]);
  await app.until(s => s.counts.attempts === 1); await app.stop();
  app = await start({ MOCK_RETRY_MS: '20' });
  let state = await app.until(s => s.deliveries.length === 1);
  assert.equal(state.jobs[0].attempts, 3);
  for (const [i, scenario] of ['permanent', 'ambiguous', 'transient-always'].entries()) {
    const order = copy(); order.id = String(400 + i); order._mock_delivery = scenario;
    assert.deepEqual(await app.send(order), [202, { status: 'accepted' }]);
  }
  state = await app.until(s => s.jobs.length === 4 && s.jobs.every(j => !['queued', 'sending'].includes(j.state)));
  assert.deepEqual(state.jobs.map(j => [j.state, j.attempts, j.reason]), [
    ['sent', 3, null], ['failed', 1, 'permanent_failure'],
    ['unknown', 1, 'ambiguous_send'], ['failed', 3, 'retry_exhausted']
  ]);
  assert.equal(state.deliveries.length, 2);
  await app.stop(); app = await start();
  assert.deepEqual(await app.state(), state);
});

test('CLI: required fake secret, mock-only, loopback-only, help and invalid configuration', async t => {
  const dir = await mkdtemp(join(root, 'test/.test-session-meta-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  async function run(args, extra = {}) {
    const child = spawn(process.execPath, ['src/cli.mjs', ...args], { cwd: root, timeout: 2000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', MOCK_SIGNING_SECRET: secret,
        SHOP_DOMAIN: 'fixture-shop.myshopify.com', DATABASE_PATH: join(dir, 'queue.sqlite'),
        TRANSPORT: 'mock', HOST: '127.0.0.1', PORT: '0', ...extra } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    const [code, signal] = await once(child, 'exit');
    return { code, signal, stdout, stderr };
  }
  for (const extra of [ { MOCK_SIGNING_SECRET: '' }, { MOCK_SIGNING_SECRET: 'real-secret' },
    { TRANSPORT: 'live' }, { HOST: '0.0.0.0' }, { HOST: 'localhost' }, { PORT: '-1' },
    { SHOP_DOMAIN: 'bad' }, { MOCK_RETRY_MS: '0' }, { MOCK_DISPATCH: 'anything' },
    { MOCK_SIGNING_SECRET: '', META_VERIFY_TOKEN: 'demo-only-verification-fixture-1234',
      META_APP_SECRET: 'demo-only-application-fixture-5678' } ]) {
    assert.deepEqual(await run(['serve'], extra), {
      code: 1, signal: null, stdout: '', stderr: 'Configuration error. Run --help.\n'
    });
  }
  assert.deepEqual(await run(['wrong']), { code: 1, signal: null, stdout: '', stderr: 'Unknown command. Run --help.\n' });
  const help = await run(['--help']);
  assert.equal(help.code, 0); assert.equal(help.signal, null); assert.equal(help.stderr, '');
  assert.equal(help.stdout, 'Local mock only: node src/cli.mjs serve|demo|--help\n' +
    'Required: MOCK_SIGNING_SECRET=demo-only-<16+ characters>, SHOP_DOMAIN=<shop>.myshopify.com\n' +
    'Optional: DATABASE_PATH=./mock.sqlite, HOST=127.0.0.1, PORT=3000, TRANSPORT=mock\n' +
    'Mock controls: MOCK_DISPATCH=active|paused, MOCK_RETRY_MS=100 (10..60000)\n' +
    'Local Meta prototype: node src/cli.mjs receive-meta\n' +
    'Required: META_VERIFY_TOKEN, META_APP_SECRET=demo-only-<16..120 ASCII letters/digits/_/->\n' +
    'Optional: META_HOST=127.0.0.1 (or ::1), META_PORT=3001 (0..65535), META_DATABASE_PATH=./meta-inbox.sqlite\n' +
    'Synthetic persistent raw inbox: exact-body delivery dedup only; NOTHING processed or sent.\n' +
    'Fake-only local prototype: NEVER REGISTER FOR REAL EVENTS; not production-ready.\n');
});
