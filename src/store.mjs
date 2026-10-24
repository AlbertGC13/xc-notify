import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    // One connection/process owns dispatch. A second process cannot recover its active sends.
    this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE;
      PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS inbox (
        webhook_id TEXT PRIMARY KEY, business_key TEXT NOT NULL, digest TEXT NOT NULL, event_id TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox (
        business_key TEXT PRIMARY KEY, order_id TEXT NOT NULL, message TEXT, recipient TEXT,
        scenario TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mock_deliveries (
        business_key TEXT PRIMARY KEY, order_id TEXT NOT NULL, message TEXT NOT NULL, attempt INTEGER NOT NULL
      );
      UPDATE outbox SET state='unknown', reason='interrupted_send' WHERE state='sending';
      COMMIT;`);
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  record({ shop, webhookId, eventId, digest, order }) {
    const key = `${shop}|${order.id}|order_received`;
    return this.transaction(() => {
      const delivery = this.db.prepare('SELECT business_key, digest FROM inbox WHERE webhook_id=?').get(webhookId);
      if (delivery) return delivery.business_key === key && delivery.digest === digest ? 'duplicate' : 'conflict';
      const existing = this.db.prepare('SELECT 1 FROM outbox WHERE business_key=?').get(key);
      this.db.prepare('INSERT INTO inbox VALUES (?, ?, ?, ?)').run(webhookId, key, digest, eventId);
      if (existing) return 'duplicate';
      this.db.prepare(`INSERT INTO outbox
        (business_key, order_id, message, recipient, scenario, state, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(key, order.id, order.message, order.recipient, order.scenario, order.reason ? 'skipped' : 'queued', order.reason);
      return 'accepted';
    });
  }
  dispatch(retryMs) {
    const job = this.db.prepare("SELECT * FROM outbox WHERE state='queued' AND next_at<=? ORDER BY rowid LIMIT 1").get(Date.now());
    if (!job) return;
    // Persist the uncertain boundary BEFORE simulated transport. Crashes here never blind-resend.
    this.transaction(() => this.db.prepare("UPDATE outbox SET state='sending', attempts=attempts+1 WHERE business_key=?").run(job.business_key));
    const attempt = job.attempts + 1;
    if (job.scenario === 'interrupted') return; // Fixture simulates interruption after durable claim.
    this.transaction(() => {
      let state = 'sent', reason = null, nextAt = 0;
      if (job.scenario === 'permanent') {
        state = 'failed'; reason = 'permanent_failure';
      } else if (job.scenario === 'transient-always' || (job.scenario === 'transient' && attempt < 3)) {
        state = attempt < 3 ? 'queued' : 'failed';
        reason = attempt < 3 ? 'transient_failure' : 'retry_exhausted';
        nextAt = Date.now() + retryMs * 2 ** (attempt - 1);
      } else {
        // This IS the mock transport: a durable local observation, never an external request.
        this.db.prepare('INSERT INTO mock_deliveries VALUES (?, ?, ?, ?)')
          .run(job.business_key, job.order_id, job.message, attempt);
        if (job.scenario === 'ambiguous') { state = 'unknown'; reason = 'ambiguous_send'; }
      }
      this.db.prepare('UPDATE outbox SET state=?, reason=?, next_at=? WHERE business_key=?')
        .run(state, reason, nextAt, job.business_key);
    });
  }
  snapshot() {
    return {
      counts: {
        inbox: this.db.prepare('SELECT count(*) AS n FROM inbox').get().n,
        outbox: this.db.prepare('SELECT count(*) AS n FROM outbox').get().n,
        attempts: this.db.prepare('SELECT coalesce(sum(attempts),0) AS n FROM outbox').get().n
      },
      jobs: this.db.prepare('SELECT order_id AS orderId, state, reason, attempts FROM outbox ORDER BY rowid').all(),
      deliveries: this.db.prepare('SELECT order_id AS orderId, message, attempt FROM mock_deliveries ORDER BY rowid').all()
    };
  }
  close() { this.db.close(); }
}
