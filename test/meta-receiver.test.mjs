import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const token = 'demo-only-verification-fixture-1234';
const secret = 'demo-only-application-fixture-5678';
const signature = (body, key = secret) => 'sha256=' + createHmac('sha256', key).update(body).digest('hex');

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
      cwd: dir, env: { ...process.env, META_VERIFY_TOKEN: token, META_APP_SECRET: secret,
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
  let app;
  await t.test('receive-meta starts without Shopify config or SQLite and stops cleanly', async () => {
    app = await launch().ready();
    assert.ok(Number.isInteger(app.port) && app.port > 0);
  });
  if (!app) return;
  const send = (body = Buffer.from('{}'), headers = {}, path = '/webhooks/meta', method = 'POST') =>
    new Promise((accept, reject) => {
      const req = request({ host: '127.0.0.1', port: app.port, path, method,
        headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json',
          'x-hub-signature-256': signature(body), ...headers }).filter(([, value]) => value !== undefined)) }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => accept({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
      req.on('error', reject); req.end(body);
    });
  const verify = `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=00042`;
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
  await t.test('Meta success and rejection leave isolated mock counts and receiver files unchanged', async () => {
    assert.deepEqual(await readdir(dir), []);
    const mock = await launch('serve', { MOCK_SIGNING_SECRET: 'demo-only-signing-secret-fixture',
      SHOP_DOMAIN: 'fixture-shop.myshopify.com', DATABASE_PATH: join(dir, 'mock.sqlite'),
      HOST: '127.0.0.1', PORT: '0', TRANSPORT: 'mock', MOCK_DISPATCH: 'paused' }).ready();
    const state = async () => (await fetch(`http://127.0.0.1:${mock.port}/mock/state`)).json();
    const before = await state(); const files = await readdir(dir);
    assert.equal((await send()).status, 200);
    assert.equal((await send(undefined, { 'x-hub-signature-256': '' })).status, 401);
    assert.deepEqual(await state(), before); assert.deepEqual(await readdir(dir), files);
    // SQLite's existing experimental warning belongs only to the mock child.
    const child = children.at(-1); child.stdin.end('stop\n'); await once(child, 'close');
  });
  await t.test('receiver alone never creates files and clean stdin stop preserves exact stdout', async () => {
    await app.stop();
    assert.deepEqual((await readdir(dir)).filter(name => !name.startsWith('mock.sqlite')), []);
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
