import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { prepareOrder } from './order.mjs';
import { Store } from './store.mjs';

const MAX_BODY = 65536;
function reply(response, code, value) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, exceeded = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!exceeded) { exceeded = true; reject(new Error('body_too_large')); }
      } else if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('aborted')));
  });
}
export async function start(config) {
  // Defend this exported startup boundary too, not only the CLI.
  if (config.transport !== 'mock' || !['127.0.0.1', '::1'].includes(config.host)) throw new Error('invalid_config');
  const store = new Store(config.database);
  let timer;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/mock/state') {
        reply(response, 200, store.snapshot()); return;
      }
      if (request.method !== 'POST' || request.url !== '/webhooks/orders/create') {
        request.resume(); reply(response, 404, { error: 'not_found' }); return;
      }
      const headers = request.headers;
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] ?? '') ||
          (headers['content-encoding'] && headers['content-encoding'] !== 'identity')) {
        request.resume(); reply(response, 415, { error: 'unsupported_body' }); return;
      }
      const raw = await readBody(request);
      const signature = headers['x-shopify-hmac-sha256'];
      const expected = createHmac('sha256', config.secret).update(raw).digest();
      if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature) ||
          Buffer.from(signature, 'base64').toString('base64') !== signature ||
          !timingSafeEqual(Buffer.from(signature, 'base64'), expected)) {
        reply(response, 401, { error: 'invalid_signature' }); return;
      }
      if (headers['x-shopify-shop-domain'] !== config.shop || headers['x-shopify-topic'] !== 'orders/create') {
        reply(response, 403, { error: 'invalid_source' }); return;
      }
      const webhookId = headers['x-shopify-webhook-id'];
      const eventId = headers['x-shopify-event-id'] ?? null;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(webhookId ?? '') ||
          (eventId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(eventId))) {
        reply(response, 400, { error: 'invalid_delivery_id' }); return;
      }
      let parsed, order;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { reply(response, 400, { error: 'invalid_json' }); return; }
      try { order = prepareOrder(parsed); }
      catch { reply(response, 422, { error: 'invalid_order' }); return; }
      const result = store.record({ shop: config.shop, webhookId, eventId, order,
        digest: createHash('sha256').update(raw).digest('hex') });
      if (result === 'conflict') reply(response, 409, { error: 'delivery_conflict' });
      else reply(response, result === 'accepted' ? 202 : 200, { status: result });
    } catch (error) {
      // Never log exceptions containing raw bodies, recipients or signing material.
      reply(response, error.message === 'body_too_large' ? 413 : 503,
        { error: error.message === 'body_too_large' ? 'body_too_large' : 'storage_or_request_failure' });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) { store.close(); throw error; }
  if (config.dispatch === 'active') timer = setInterval(() => {
    try { store.dispatch(config.retryMs); }
    catch {
      // Halt on storage uncertainty; restart resolves any persisted sending row to unknown.
      clearInterval(timer);
      process.stderr.write('Dispatcher stopped: storage uncertainty. Restart for recovery.\n');
    }
  }, 10);
  return {
    port: server.address().port,
    async close() {
      clearInterval(timer);
      await new Promise(resolve => server.close(resolve));
      store.close();
    }
  };
}
