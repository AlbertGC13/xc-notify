import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const token = 'demo-only-verification-fixture-1234';
const secret = 'demo-only-application-fixture-5678';
const signature = (body, key = secret) => 'sha256=' + createHmac('sha256', key).update(body).digest('hex');

test('configuration isolation: unrelated nonexistent order parent does not block a distinct valid Meta inbox', { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(root, 'test/.test-session-meta-isolation-'));
  const child = spawn(process.execPath, [join(root, 'src/cli.mjs'), 'receive-meta'], {
    cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1', META_VERIFY_TOKEN: token,
      META_APP_SECRET: secret, META_HOST: '127.0.0.1', META_PORT: '0',
      META_DATABASE_PATH: join(dir, 'isolated.sqlite'),
      DATABASE_PATH: join(dir, 'nonexistent-order-parent/orders.sqlite'),
      MOCK_SIGNING_SECRET: '', SHOP_DOMAIN: '' }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((accept, reject) => {
    child.stdout.on('data', () => {
      try { if (stdout.includes('\n')) accept(JSON.parse(stdout).listening); }
      catch (error) { reject(error); }
    });
    child.once('close', code => reject(new Error(`startup ${code}: ${stderr}`)));
  });
  assert.ok(Number.isInteger(port) && port > 0);
  const base = `http://127.0.0.1:${port}`;
  const initial = await fetch(`${base}/mock/meta-inbox`);
  assert.equal(initial.status, 200); assert.deepEqual(await initial.json(), { count: 0 });
  const body = Buffer.from('{"synthetic":"isolation-é"}');
  const response = await fetch(`${base}/webhooks/meta`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature(body) } });
  assert.equal(response.status, 200); assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  const count = await fetch(`${base}/mock/meta-inbox`);
  assert.equal(count.status, 200); assert.deepEqual(await count.json(), { count: 1 });
  const sha256 = createHash('sha256').update(body).digest('hex');
  const stored = await fetch(`${base}/mock/meta-inbox/${sha256}`);
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), { sha256, bytes: body.length });
  child.stdin.end('stop\n');
  assert.deepEqual(await exited, [0, null]);
  assert.equal(stdout, `${JSON.stringify({ listening: port })}\n`); assert.equal(stderr, '');
  assert.deepEqual(await readdir(dir), ['isolated.sqlite']);
});

test('Meta public CLI and HTTP contract', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(root, 'test/.test-session-meta-receiver-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(); await exited;
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  function launch(command = 'receive-meta', extra = {}, args = []) {
    const child = spawn(process.execPath, [join(root, 'src/cli.mjs'), command, ...args], {
      cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1', META_VERIFY_TOKEN: token, META_APP_SECRET: secret,
        META_HOST: '127.0.0.1', META_PORT: '0', MOCK_SIGNING_SECRET: '', SHOP_DOMAIN: '', ...extra }
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const exit = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
    return { child, exit, async ready() {
      const port = await new Promise((accept, reject) => {
        child.stdout.on('data', () => {
          if (stdout.includes('\n')) {
            try { accept(JSON.parse(stdout).listening); } catch (error) { reject(error); }
          }
        });
        child.once('exit', code => reject(new Error(`startup ${code}: ${stderr}`)));
      });
      return { port, async stop() {
        child.stdin.end('stop\n');
        assert.deepEqual(await exit, { code: 0, signal: null,
          stdout: `${JSON.stringify({ listening: port })}\n`, stderr: '' });
      } };
    } };
  }
  const refused = extra => {
    const run = launch('receive-meta', extra);
    // Baseline ignores the new setting: stop it rather than hanging the RED run.
    run.child.stdin.end('stop\n');
    return run.exit;
  };
  let app;
  await t.test('receive-meta starts without Shopify config and uses only its dedicated inbox', async () => {
    app = await launch().ready();
    assert.ok(Number.isInteger(app.port) && app.port > 0);
  });
  if (!app) return;
  const send = (body = Buffer.from('{}'), headers = {}, path = '/webhooks/meta', method = 'POST') =>
    new Promise((accept, reject) => {
      const req = request({ host: '127.0.0.1', port: app.port, path, method,
        headers: Object.fromEntries(Object.entries({ 'content-length': body.length, 'content-type': 'application/json',
          'x-hub-signature-256': signature(body), ...headers }).filter(([, value]) => value !== undefined)) }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => accept({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
      req.on('error', reject); req.end(body);
    });
  const verify = `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=00042`;
  const sha = body => createHash('sha256').update(body).digest('hex');
  const count = async () => {
    const response = await send(undefined, {}, '/mock/meta-inbox', 'GET');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    return JSON.parse(response.text);
  };
  const stored = async body => {
    const response = await send(undefined, {}, `/mock/meta-inbox/${sha(body)}`, 'GET');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { sha256: sha(body), bytes: body.length });
  };
  await t.test('durable exact raw bytes: whitespace and UTF8 stay distinct without business normalization', async () => {
    assert.deepEqual(await count(), { count: 0 });
    for (const body of [Buffer.from('{"synthetic":"é"}'), Buffer.from('{ "synthetic":"é" }\n')]) {
      const result = await send(body);
      assert.equal(result.status, 200); assert.equal(result.text, '');
      assert.equal(result.headers['content-type'], 'text/plain; charset=utf-8');
      await stored(body);
    }
    assert.deepEqual(await count(), { count: 2 });
  });
  await t.test('persistent uniqueness: concurrent identical POSTs add exactly one receipt', async () => {
    const before = await count(); const body = Buffer.from('{"concurrent":true}');
    const results = await Promise.all(Array.from({ length: 16 }, () => send(body)));
    for (const result of results) { assert.equal(result.status, 200); assert.equal(result.text, ''); }
    assert.deepEqual(await count(), { count: before.count + 1 }); await stored(body);
  });
  await t.test('clean restart preserves stored bytes and exact-body dedup', async () => {
    const body = Buffer.from('{"restart":true}');
    assert.equal((await send(body)).status, 200); const before = await count();
    await app.stop(); app = await launch().ready();
    await stored(body); assert.equal((await send(body)).status, 200);
    assert.deepEqual(await count(), before);
  });
  await t.test('owned process hard kill after ACK preserves committed body and dedup', async () => {
    const body = Buffer.from('{"crash":true}');
    assert.equal((await send(body)).status, 200); const before = await count();
    const child = children.at(-1); const exited = once(child, 'close'); child.kill('SIGKILL');
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    app = await launch().ready(); await stored(body);
    assert.equal((await send(body)).status, 200); assert.deepEqual(await count(), before);
  });
  await t.test('public diagnostics are bounded read-only metadata, unknown hashes and methods are absent', async () => {
    const before = await count();
    for (const [path, method] of [[`/mock/meta-inbox/${'0'.repeat(64)}`, 'GET'],
      [`/mock/meta-inbox/${'A'.repeat(64)}`, 'GET'], ['/mock/meta-inbox', 'POST'],
      ['/mock/meta-inbox/all', 'GET'], ['/mock/state', 'GET']]) {
      const response = await send(undefined, {}, path, method);
      assert.equal(response.status, 404); assert.equal(response.text, '');
    }
    assert.deepEqual(await count(), before);
  });
  await t.test('auth UTF8 JSON media bounds and verification rejections have no receipt effects', async () => {
    const before = await count();
    for (const [body, headers, path, method, status] of [
      [Buffer.from('{}'), { 'x-hub-signature-256': '' }, '/webhooks/meta', 'POST', 401],
      [Buffer.from([0x22, 0xff, 0x22]), {}, '/webhooks/meta', 'POST', 400],
      [Buffer.from('{'), {}, '/webhooks/meta', 'POST', 400],
      [Buffer.from('{}'), { 'content-type': 'text/plain' }, '/webhooks/meta', 'POST', 415],
      [Buffer.alloc(3 * 1024 * 1024 + 1, 32), {}, '/webhooks/meta', 'POST', 413],
      [Buffer.from('{}'), {}, verify.replace(token, 'wrong'), 'GET', 403],
      [Buffer.from('{}'), {}, verify, 'GET', 200]
    ]) {
      const response = await send(body, headers, path, method); assert.equal(response.status, status);
      assert.equal(response.text, status === 200 ? '00042' : '');
      assert.deepEqual(await count(), before);
    }
    await stored(Buffer.from('{"crash":true}'));
  });
  await t.test('GET returns exact decoded bounded challenge as plain text preserving zeros', async () => {
    const result = await send(undefined, {}, verify, 'GET');
    assert.equal(result.status, 200); assert.equal(result.text, '00042');
    assert.match(result.headers['content-type'], /^text\/plain/);
    assert.equal((await send(undefined, {}, verify.replace('00042', 'a%20b%2Bc'), 'GET')).text, 'a b+c');
  });
  await t.test('GET rejects missing wrong duplicate and empty or oversized verification fields', async () => {
    for (const path of [verify.replace('subscribe', 'bad'), verify.replace(token, 'wrong'),
      verify.replace('&hub.challenge=00042', ''), verify.replace('00042', ''),
      verify.replace(`hub.verify_token=${token}&`, ''), verify.replace('hub.mode=subscribe&', ''),
      verify + '&hub.mode=subscribe', verify + `&hub.verify_token=${token}`,
      verify + '&hub.challenge=1', verify.replace('00042', 'x'.repeat(1025))]) {
      assert.equal((await send(undefined, {}, path, 'GET')).status, 403);
    }
  });
  await t.test('POST ACKs signed unknown JSON without normalization and repeated requests may ACK', async () => {
    for (const body of [Buffer.from('{"unknown":{"business":"discard"}}'), Buffer.from('null'), Buffer.from('{}')]) {
      assert.equal((await send(body)).status, 200);
      assert.equal((await send(body)).status, 200);
    }
  });
  await t.test('POST rejects missing malformed duplicate base64 wrong-key and tampered raw signatures', async () => {
    const body = Buffer.from('{}');
    for (const value of ['', 'sha256=bad', signature(body, token), signature(body, 'wrong'),
      'sha256=' + createHmac('sha256', secret).update(body).digest('base64'),
      [signature(body), signature(body)], signature(Buffer.from('{} '))]) {
      assert.equal((await send(body, { 'x-hub-signature-256': value })).status, 401);
    }
    // A genuinely absent header, not merely an empty value.
    assert.equal((await send(body, { 'x-hub-signature-256': undefined })).status, 401);
  });
  await t.test('POST authenticates raw bytes before fatal UTF8 and JSON parsing', async () => {
    for (const body of [Buffer.from('{'), Buffer.from([0x22, 0xff, 0x22])]) {
      assert.equal((await send(body)).status, 400);
      assert.equal((await send(body, { 'x-hub-signature-256': signature(Buffer.from('{}')) })).status, 401);
    }
    assert.equal((await send(Buffer.from('{ }\n'))).status, 200);
  });
  await t.test('POST rejects nonJSON unsupported charset compression and duplicate content type', async () => {
    for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/json; charset=latin1' },
      { 'content-encoding': 'gzip' }, { 'content-type': ['application/json', 'application/json'] }]) {
      assert.equal((await send(undefined, headers)).status, 415);
    }
    assert.equal((await send(undefined, { 'content-type': 'application/json; charset=UTF-8' })).status, 200);
  });
  await t.test('POST permits exactly 3MiB raw bytes and rejects larger bodies', async () => {
    assert.equal((await send(Buffer.from('"' + 'x'.repeat(3 * 1024 * 1024 - 2) + '"'))).status, 200);
    assert.equal((await send(Buffer.alloc(3 * 1024 * 1024 + 1, 32))).status, 413);
  });
  await t.test('unknown routes methods mock and Shopify interfaces are absent', async () => {
    for (const [path, method] of [['/mock/state', 'GET'], ['/webhooks/orders/create', 'POST'],
      ['/webhooks/meta', 'PUT'], ['/missing', 'GET']]) {
      assert.equal((await send(undefined, {}, path, method)).status, 404);
    }
  });
  await t.test('absolute deadlines terminate slow headers slow body and idle sockets; abort never ACKs', async () => {
    async function probe(initial, drip = '', abort = false) {
      const started = Date.now();
      const socket = connect(app.port, '127.0.0.1'); let output = '';
      socket.on('data', c => { output += c; }); socket.on('error', () => {});
      await once(socket, 'connect'); socket.write(initial);
      const timer = drip ? setInterval(() => socket.write(drip), 200) : undefined;
      const closed = new Promise(accept => socket.once('close', accept));
      if (abort) socket.destroy();
      try { await closed; } finally { clearInterval(timer); socket.destroy(); }
      assert.doesNotMatch(output, /HTTP\/1\.1 2\d\d/);
      assert.ok(Date.now() - started < 6500, 'absolute deadline exceeded');
    }
    await Promise.all([
      probe('GET /webhooks/meta HTTP/1.1\r\nHost: localhost\r\nX-Slow: ', 'x'),
      probe('POST /webhooks/meta HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
        `X-Hub-Signature-256: ${signature(Buffer.from('{}'))}\r\nContent-Length: 1000\r\n\r\n`, ' '),
      probe(''), probe('POST /webhooks/meta HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\n{', '', true)
    ]);
  });
  await t.test('8KiB header cap rejects oversized request headers', async () => {
    assert.equal((await send(undefined, { 'x-padding': 'x'.repeat(8192) })).status, 431);
  });
  await t.test('Meta success and rejection leave isolated mock counts and order files unchanged', async () => {
    const receiverFiles = await readdir(dir);
    const mock = await launch('serve', { MOCK_SIGNING_SECRET: 'demo-only-signing-secret-fixture',
      SHOP_DOMAIN: 'fixture-shop.myshopify.com', DATABASE_PATH: join(dir, 'orders.sqlite'),
      HOST: '127.0.0.1', PORT: '0', TRANSPORT: 'mock', MOCK_DISPATCH: 'paused' }).ready();
    const state = async () => (await fetch(`http://127.0.0.1:${mock.port}/mock/state`)).json();
    const order = await readFile(join(root, 'fixtures/order.json'));
    const receipt = await fetch(`http://127.0.0.1:${mock.port}/webhooks/orders/create`, {
      method: 'POST', body: order, headers: { 'content-type': 'application/json',
        'x-shopify-shop-domain': 'fixture-shop.myshopify.com', 'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'synthetic-isolation',
        'x-shopify-hmac-sha256': createHmac('sha256', 'demo-only-signing-secret-fixture').update(order).digest('base64') }
    });
    assert.equal(receipt.status, 202); assert.deepEqual(await receipt.json(), { status: 'accepted' });
    const before = await state(); const files = await readdir(dir);
    const orderHash = sha(await readFile(join(dir, 'orders.sqlite')));
    assert.equal((await send()).status, 200);
    assert.equal((await send(undefined, { 'x-hub-signature-256': '' })).status, 401);
    assert.deepEqual(await state(), before); assert.deepEqual(await readdir(dir), files);
    assert.equal(sha(await readFile(join(dir, 'orders.sqlite'))), orderHash);
    // SQLite's existing experimental warning belongs only to the mock child.
    const child = children.at(-1); child.stdin.end('stop\n'); await once(child, 'close');
    assert.deepEqual(receiverFiles, ['meta-inbox.sqlite']);
  });
  await t.test('receiver creates only owned inbox and clean stdin stop preserves exact stdout', async () => {
    await app.stop();
    assert.deepEqual((await readdir(dir)).filter(name => !name.startsWith('orders.sqlite')), ['meta-inbox.sqlite']);
  });
  await t.test('foreign files and public mock-created database are rejected unchanged without sidecars', async () => {
    const foreign = join(dir, 'foreign.sqlite'); await writeFile(foreign, 'synthetic foreign file');
    for (const path of [foreign, join(dir, 'orders.sqlite')]) {
      const before = await readFile(path); const files = await readdir(dir);
      assert.deepEqual(await refused({ META_DATABASE_PATH: path }),
        { code: 1, signal: null, stdout: '', stderr: 'Local Meta receiver failed.\n' });
      assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(dir), files);
    }
  });
  await t.test('configured and default mock database paths fail configuration without files or order state changes', async () => {
    const before = await readFile(join(dir, 'orders.sqlite')); const files = await readdir(dir);
    for (const extra of [{ META_DATABASE_PATH: './mock.sqlite' },
      { META_DATABASE_PATH: './collision.sqlite', DATABASE_PATH: './collision.sqlite' },
      { META_DATABASE_PATH: '' }]) {
      assert.deepEqual(await refused(extra),
        { code: 1, signal: null, stdout: '', stderr: 'Configuration error. Run --help.\n' });
    }
    assert.deepEqual(await readFile(join(dir, 'orders.sqlite')), before);
    assert.deepEqual(await readdir(dir), files);
  });
  await t.test('configuration rejects unsafe secrets ports and binds before listening with generic errors', async () => {
    for (const extra of [{ META_VERIFY_TOKEN: '' }, { META_APP_SECRET: '' }, { META_APP_SECRET: 'real-secret' },
      { META_VERIFY_TOKEN: 'demo-only-' + 'x'.repeat(121) }, { META_APP_SECRET: 'demo-only-' + 'é'.repeat(16) },
      { META_VERIFY_TOKEN: 'demo-only-short' }, { META_PORT: '-1' }, { META_PORT: '65536' },
      { META_PORT: '1e3' }, { META_HOST: '0.0.0.0' }, { META_HOST: 'localhost' }]) {
      assert.deepEqual(await launch('receive-meta', extra).exit,
        { code: 1, signal: null, stdout: '', stderr: 'Configuration error. Run --help.\n' });
    }
  });
  await t.test('receive-meta rejects extra arguments without consulting configuration', async () => {
    assert.deepEqual(await launch('receive-meta', {}, ['extra']).exit,
      { code: 1, signal: null, stdout: '', stderr: 'Unknown command. Run --help.\n' });
  });
});
