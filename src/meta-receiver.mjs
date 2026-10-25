import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { realpathSync, existsSync, statSync } from 'node:fs';

const limit = 3 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();

export function configuration(env) {
  const token = env.META_VERIFY_TOKEN, secret = env.META_APP_SECRET;
  const host = env.META_HOST ?? '127.0.0.1', port = env.META_PORT ?? '3001';
  if (![token, secret].every(value => /^demo-only-[A-Za-z0-9_-]{16,120}$/.test(value ?? '')) ||
      !['127.0.0.1', '::1'].includes(host) || !/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    throw new Error('Configuration error. Run --help.');
  }
  let database;
  try {
    if (env.META_DATABASE_PATH === '') throw new Error();
    database = resolve(env.META_DATABASE_PATH ?? './meta-inbox.sqlite');
    const canonical = (path, optional = false) => {
      if (existsSync(path)) return realpathSync(path);
      try { return resolve(realpathSync(dirname(path)), basename(path)); }
      catch (error) {
        // An unrelated application's missing directory is not a Meta dependency.
        // Keep our own parent strict, and do not ignore access or other failures.
        if (optional && error.code === 'ENOENT') return path;
        throw error;
      }
    };
    for (const mock of [resolve('./mock.sqlite'), resolve(env.DATABASE_PATH || './mock.sqlite')]) {
      if (canonical(database).toLowerCase() === canonical(mock, true).toLowerCase() ||
          (existsSync(database) && existsSync(mock) && statSync(database).ino === statSync(mock).ino &&
           statSync(database).dev === statSync(mock).dev)) throw new Error();
    }
  } catch { throw new Error('Configuration error. Run --help.'); }
  return { token, secret, host, port: Number(port), database };
}

export async function start(config) {
  // SQLite is loaded only for Meta startup, after CLI configuration validates.
  const { openInbox } = await import('./meta-inbox.mjs');
  const inbox = openInbox(config.database);
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const reply = (status, text = '', type = 'text/plain; charset=utf-8') => {
      if (res.destroyed || res.writableEnded || req.aborted) return;
      res.writeHead(status, { 'content-type': type, connection: 'close' });
      res.end(text);
    };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { reply(404); return; }
    if (req.method === 'GET' && (url.pathname === '/mock/meta-inbox' ||
        /^\/mock\/meta-inbox\/[a-f0-9]{64}$/.test(url.pathname))) {
      try {
        const value = url.pathname === '/mock/meta-inbox' ? inbox.count() : inbox.receipt(url.pathname.split('/').at(-1));
        if (value) reply(200, JSON.stringify(value), 'application/json; charset=utf-8');
        else reply(404);
      } catch { reply(503); }
      return;
    }
    if (url.pathname !== '/webhooks/meta' || !['GET', 'POST'].includes(req.method)) {
      reply(404); return;
    }
    if (req.method === 'GET') {
      const fields = ['hub.mode', 'hub.verify_token', 'hub.challenge'];
      const [mode, token, challenge] = fields.map(key => url.searchParams.get(key));
      if (fields.some(key => url.searchParams.getAll(key).length !== 1) || mode !== 'subscribe' ||
          !challenge || Buffer.byteLength(challenge) > 1024 ||
          !timingSafeEqual(digest(token ?? ''), digest(config.token))) {
        reply(403); return;
      }
      reply(200, challenge); return;
    }
    const values = name => {
      const result = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === name) result.push(req.rawHeaders[i + 1]);
      }
      return result;
    };
    const signatures = values('x-hub-signature-256');
    if (signatures.length !== 1 || !/^sha256=[a-fA-F0-9]{64}$/.test(signatures[0])) {
      reply(401); return;
    }
    const types = values('content-type');
    if (types.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(types[0]) ||
        values('content-encoding').length !== 0) {
      reply(415); return;
    }
    let size = 0, exceeded = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        exceeded = true; chunks.length = 0; reply(413); req.pause();
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on('error', () => { /* Aborted uploads are discarded, never acknowledged. */ });
    req.on('end', () => {
      if (exceeded || req.aborted || !req.complete) return;
      const body = Buffer.concat(chunks);
      const expected = createHmac('sha256', config.secret).update(body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signatures[0].slice(7), 'hex'))) {
        reply(401); return;
      }
      try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { reply(400); return; }
      try { inbox.record(body); }
      catch { reply(503); return; } // Never claim success on a storage/commit failure.
      reply(200);
    });
  });
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    // Absolute connection lifetime bounds idle sockets, trickled headers AND bodies.
    // Unlike Node's swept/inactivity timeouts, activity cannot extend this deadline.
    const deadline = setTimeout(() => socket.destroy(), 5000);
    deadline.unref();
    socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket); });
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end(`HTTP/1.1 ${error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.removeListener('error', reject); accept(); });
    });
  } catch (error) { server.close(); inbox.close(); throw error; }
  return { port: server.address().port, close: () => new Promise((accept, reject) => {
    server.close(error => {
      try { inbox.close(); } catch (failure) { reject(failure); return; }
      error ? reject(error) : accept();
    });
    for (const socket of sockets) socket.destroy();
  }) };
}
