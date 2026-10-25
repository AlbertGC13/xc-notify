# XC Notify

A standalone Node built-ins-only mock backend for buyer order confirmations.
It receives **fake, signed `orders/create`** events and records simulated WhatsApp deliveries.
It does not connect to Shopify, Meta, a bank, a customer account or capellanpc.
**Not production-ready. No real messages, order creation, payment changes or inventory writes.**

## Quickstart (Node >=24.15)

Run from the cloned `xc-notify` repository root; no install or dependencies are needed.
Current local verification uses Node 24.16.0. The future test host is not verified here.

```sh
# Bash / Git Bash: intentionally fake, NONSECRET configuration.
export MOCK_SIGNING_SECRET=demo-only-signing-secret-fixture
export SHOP_DOMAIN=fixture-shop.myshopify.com
export NODE_NO_WARNINGS=1  # optional: suppress Node's experimental SQLite warning
node src/cli.mjs --help
node src/cli.mjs demo
npm test
```

PowerShell equivalents: `$env:MOCK_SIGNING_SECRET='demo-only-signing-secret-fixture'`,
`$env:SHOP_DOMAIN='fixture-shop.myshopify.com'`, `$env:NODE_NO_WARNINGS='1'`.
The demo signs the **actual bytes** in `fixtures/order.json` with HMAC-SHA256/base64,
starts an ephemeral loopback listener, posts the fixture twice and checks public mock state.
It prints `mock demo: accepted=202 replay=200 deliveries=1` followed by the Spanish summary.
It closes the listener and removes only its own uniquely named `.demo-session-*` directory.
No external network request occurs. No real order is created.

For a persistent local session, run `node src/cli.mjs serve`. Its sole startup stdout line
is JSON, e.g. `{"listening":3000}`. Stop with Ctrl+C, SIGTERM on Unix, or the stdin line
`stop` followed by Enter (portable graceful shutdown on Windows). Keep this terminal local.
Use fixtures only, not real buyer/order data.

## Configuration and commands

Environment values are read directly; there is **no automatic .env loading**. Configuration
examples are deliberately nonsecret; never substitute real credentials or tokens.
Use the inline configuration above; no environment file is required. Keep local secrets out of Git.

| Variable | Default / requirement |
|---|---|
| `MOCK_SIGNING_SECRET` | Required: `demo-only-` plus 16–120 ASCII letters, digits, `_` or `-`. Example above is public, not a credential. |
| `SHOP_DOMAIN` | Required exact lower-case `<shop>.myshopify.com`, e.g. `fixture-shop.myshopify.com`. No store connection is configured. |
| `TRANSPORT` | `mock` only. Any other value fails before DB/listener startup. No live adapter exists. |
| `HOST` | `127.0.0.1`; only this literal and `::1` are accepted. No wildcard, hostname or public bind. |
| `PORT` | `3000`; integer 0–65535 (`0` selects an ephemeral port). |
| `DATABASE_PATH` | `./mock.sqlite`, relative to working directory. Use a new local path with an existing parent directory. |
| `MOCK_DISPATCH` | `active` or `paused`; paused accepts durable events without dispatch. |
| `MOCK_RETRY_MS` | `100`; integer 10–60000. Exponential base delay, at most three total attempts. |

Commands are `serve`, `demo`, `--help`. Extra/unknown arguments exit 1 with
`Unknown command. Run --help.`; invalid configuration exits 1 with
`Configuration error. Run --help.` (stderr only). Storage/bind failures exit 1 with a generic
local failure message, without echoing secrets, payloads or filesystem details.
`demo` still requires valid config but always uses an ephemeral port/DB and active dispatch.
There are no access tokens, account setup, deployment, tunnels, systemd or installation scripts.

## Local Meta synthetic persistent raw inbox

**NEVER REGISTER FOR REAL EVENTS.** Fake-only, loopback-only and **not production-ready**.
Authenticated synthetic raw notifications are committed locally before ACK. Exact-body delivery
retries deduplicate by SHA256; different raw bytes (even equivalent JSON) remain separate receipts.
This is NOT business/message deduplication. **NOTHING is processed or sent.** No order normalization,
worker, retry processing or connection to accounts exists. Do not expose this receiver.

```sh
# Public fake fixtures only; no Shopify variables or environment file required.
META_VERIFY_TOKEN=demo-only-verification-fixture-1234 \
META_APP_SECRET=demo-only-application-fixture-5678 \
node src/cli.mjs receive-meta
```

Both required Meta values must be `demo-only-` plus 16–120 ASCII letters/digits/`_`/`-`.
`META_HOST` defaults to `127.0.0.1`, accepting only that literal or `::1`;
`META_PORT` defaults to `3001`, accepting integers 0–65535 (0 allocates a port).
`META_DATABASE_PATH` defaults to `./meta-inbox.sqlite`, relative to the working directory;
use a dedicated local file in an existing parent directory. Only `receive-meta` uses this variable.
Configured and default mock database paths are rejected, including aliases; the order store is
never imported or changed. New files are exclusively created with a fixed SQLite ownership/version
marker and transactional schema initialization. Existing files must pass a read-only header check
before any SQLite open, then read-only exact schema validation. Foreign, unmarked, incompatible
or incomplete initialization files fail closed: no migration, repair, overwrite or deletion.

The Meta-only database stores original raw body BLOBs and a unique SHA256 under FULL synchronous
transactions. Commit completes before HTTP 200; exact duplicates return the same empty 200 without
another receipt. Storage failures return empty generic 503, never a success ACK. Retain the same
owned database across clean restart or crash to preserve receipts and deduplication. Stop before
copying the database for a backup. No retention, pruning, quotas or deletion are supplied: data grows
without bound, and disk/filesystem durability remain risks. This database is only for fake data.

Startup emits `{"listening":<port>}` plus newline (Node may also emit its experimental SQLite
warning on stderr); stdin `stop`, Ctrl+C or SIGTERM closes the listener and database.
Configuration errors retain the generic CLI message; storage/bind failures say `Local Meta receiver failed.`

`GET` and `POST /webhooks/meta` retain their protocol. GET requires exactly one each of
`hub.mode=subscribe`, `hub.verify_token` and a nonempty decoded `hub.challenge` (at most
1024 UTF-8 bytes). A matching token returns 200 plain text with the exact challenge,
including leading zeros, without a newline; invalid verification returns 403.
POST requires exactly one `X-Hub-Signature-256: sha256=<64 hex digits>` authenticating the
**original bytes** using the fake app secret, not the verification token or Shopify base64.
Valid signed UTF-8 JSON returns 200 with an empty body. Missing/invalid signatures return
401, invalid UTF-8/JSON 400, unsupported content type/charset/compression 415, oversized
bodies 413, and unknown routes/methods 404. Rejections and verification never write receipts.
No payload/token/path is logged.

Read-only, unauthenticated local synthetic diagnostics (never proxy/expose these):
- `GET /mock/meta-inbox` returns only JSON `{"count":N}`.
- `GET /mock/meta-inbox/<lowercase-64-hex-sha256>` returns JSON `{"sha256":"…","bytes":N}`,
  recomputed from the stored BLOB; an unknown digest returns empty 404.
There is no listing or raw-body/path exposure. `/mock/state` and Shopify routes remain absent
in Meta mode; the separate mock process and its interfaces are unchanged.

The raw body limit is 3 MiB, headers 8 KiB. Each connection has a real absolute five-second
lifetime, including idle time, headers and body; trickled activity cannot renew it. Responses
close the connection. Interrupted/expired uploads are discarded without a successful ACK.
This intentionally restrictive local deadline is not a production ingress design.

## Public mock interfaces

All routes exist **only in this mock-only, loopback-bound process**. Do not proxy or expose them.
There is no production diagnostics/authentication design; local processes can read mock messages.
No CORS access is granted. Never treat these endpoints as safe for real protected customer data.

`POST /webhooks/orders/create` requires `application/json` (optional UTF-8 charset), no compression,
and at most 65,536 raw bytes. Header limit is 8 KiB; header/request timeout is five seconds.
HMAC authenticates the original bytes **before JSON decoding**. Required headers:

- `X-Shopify-Hmac-Sha256`: canonical base64 HMAC-SHA256 using the configured fake secret.
- `X-Shopify-Shop-Domain`: exact configured shop; `X-Shopify-Topic`: exact `orders/create`.
- `X-Shopify-Webhook-Id`: 1–128 ASCII letters/digits/`_`/`-` (delivery dedup).
- Optional `X-Shopify-Event-Id`: same syntax; correlation only, never the business dedup key.

| HTTP | Exact JSON body / meaning |
|---|---|
| 202 | `{"status":"accepted"}` — inbox + outbox committed before ACK, including skipped jobs. |
| 200 | `{"status":"duplicate"}` — no second notification. A new delivery ID may add one inbox receipt. |
| 401 | `{"error":"invalid_signature"}` |
| 403 | `{"error":"invalid_source"}` — shop/topic mismatch (including `orders/paid`). |
| 400 | `{"error":"invalid_delivery_id"}` or `{"error":"invalid_json"}` |
| 413 / 415 | `{"error":"body_too_large"}` / `{"error":"unsupported_body"}` |
| 422 | `{"error":"invalid_order"}` — money, currency or supported fixture schema invalid. |
| 409 | `{"error":"delivery_conflict"}` — same delivery ID but different business key/raw-byte digest. |
| 503 | `{"error":"storage_or_request_failure"}` — no successful acceptance claimed. |
| 404 | `{"error":"not_found"}` — any other route/method. |

`GET /mock/state` returns 200 JSON with `counts: {inbox,outbox,attempts}`, `jobs` containing
`orderId,state,reason,attempts`, and `deliveries` containing `orderId,message,attempt`.
It omits phone numbers, raw payloads, secrets and correlation headers. This is the public
observation boundary used by tests: tests never read SQLite tables. It is intentionally
unpaginated for small fixtures and is **not** a production monitoring API.

## Fixture contract and truthful messages

`fixtures/order.json` uses the reserved fictional NANP number `+12025550101`, not a real
branch/customer. `_mock_buyer: {consent:true,evidence:"fixture-opt-in-v1",phone:"+12025550101"}`
is a **fixture-only opt-in contract**, NOT a native Shopify field and NOT connected merchant
configuration. The phone must be an explicit consented buyer E.164 string (`+`, nonzero country
prefix, 8–15 digits). This is syntax validation, not proof of identity, ownership or legal consent.
Missing/false consent or missing evidence records `skipped/missing_consent`; invalid phone records
`skipped/invalid_recipient`. No shipping/customer/profile fallback or email-marketing inference.
Use only reserved fictional numbers even though the validator accepts syntactically valid E.164.

The Spanish summary includes order name, all products, variant (when supplied), quantity,
total, discount, shipping, tax and the **recorded** financial status. COD/transfer/PayPal/gateway
selection never implies payment. Only `financial_status: "paid"` says `Pagado`; `authorized`
says `Autorizado, no pagado`; `partially_paid` says `Pago parcial`. Pending remains pending.
Refunded/partially_refunded/voided statuses are also reflected, not converted into paid claims.
There is no `orders/paid` handler or follow-up notification. That would need separate authorization.

Supported fixture fields follow `fixtures/order.json`; IDs must be positive digit strings (up to
20 digits), or safe integers. Names/items reject control/format characters; 1–100 items, quantities
1–10000. Amounts must be nonnegative **decimal strings**, at most 18 integral/6 fractional digits.
DOP/USD/EUR/CAD/GBP use 2 decimal places, JPY 0, KWD 3; unsupported currencies fail closed.
BigInt arithmetic preserves exact amounts, including values beyond Number's safe integer range.
No cart-cents interpretation, floating-point money, subtotal reconstruction or exchange rate exists.
`total_shipping_price_set` must include agreeing shop/presentment money. Other supplied total
money sets and `presentment_currency` must agree with the direct amounts and order currency;
converted/mixed-currency payloads are rejected, not silently labeled DOP/USD. Missing variant is
allowed; missing required money/status/items is not guessed. This narrow schema is not an assertion
that every real Shopify order payload is supported.

## Durable mock behavior and limits

`src/order.mjs` is the only normalizer/formatter. `Store.record` is the only transactional
inbox/business-dedup/outbox path; handler and dispatcher do not reimplement it. The business key
is `shop + order ID + order_received`. Delivery IDs and body digests detect conflicting replay;
EventId is stored solely for correlation. All deliveries of the same business key share one job,
even when later content differs. Skipped jobs also consume that key; later consent is not an
automatic resend. Outbox stores only the normalized message/recipient, not raw order bodies.

SQLite uses `synchronous=FULL`, DELETE journaling and an exclusive connection lock. Only one process
can own a database, preventing a second dispatcher from recovering another active process's sends.
A synchronous, single dispatch loop durably marks `sending` before mock transport. Fixture control:

| `_mock_delivery` | Result |
|---|---|
| `success` (default) | One durable local mock delivery, then `sent`. |
| `transient` | Two safe simulated rejections, success on attempt 3. Retry count/time survives restart. |
| `transient-always` | Three attempts, then `failed/retry_exhausted`. |
| `permanent` | One attempt, then `failed/permanent_failure`. |
| `ambiguous` | Mock records acceptance but loses acknowledgement: `unknown/ambiguous_send`, no resend. |
| `interrupted` | Leaves `sending`; restart changes it to `unknown/interrupted_send`, no resend. |

Queued work resumes on restart. Terminal failed/unknown/skipped/sent jobs do not auto-resend.
Storage errors halt dispatch; restarting conservatively resolves persisted uncertain sends.
`unknown` requires future manual reconciliation, not a hidden retry. There is no automatic
reset/replay endpoint, real provider or claim of exactly-once delivery across an external provider.

Stop gracefully before backups; copy the closed SQLite file as a unit to an access-controlled
location. Do not copy only a live DB while a journal/transaction is active. Restore only while
stopped, retain the same database to preserve dedup, and verify with fake fixtures first.
No backup automation, encryption, retention/pruning, migration tooling or multi-instance scaling
is supplied. Inbox/jobs/deliveries grow without bound; disk exhaustion and filesystem durability
remain operational risks. Never delete the DB to retry an uncertain delivery. Mock state exposes
message text; the DB also stores the explicit recipient and is not suitable for real PII here.

## Verification and future prerequisites

`npm test` runs public HTTP/CLI tests on isolated `.test-session-*` directories and cleans only
those directories. It covers signature/raw-byte tampering, shop/topic/body rejection with unchanged
counts, business/delivery replay, correlation, literal Spanish DOP/USD amounts/status, consent,
recipient validation, restart/crash recovery, bounded durable retries, permanent and unknown outcomes.
Run `node --check src/cli.mjs`, `node --check src/server.mjs`, `node --check src/store.mjs`,
`node --check src/order.mjs`; the quickstart demo is the loopback smoke check.
Generated local verification evidence, databases and session directories are ignored by Git;
they are not part of the source snapshot. Tests need no Shopify account, browser or external API.
Cloning this repository does not deploy or start a server.

Before any separately authorized real integration: verify Shopify webhook subscription/version and
protected-customer-data access; map a genuine buyer consent/recipient source with audit evidence;
review real payload/currency schema and privacy/retention policies; replace the fake-secret contract
with secure credential management; configure Meta business/number/template approvals and opt-in;
review provider idempotency/ambiguity reconciliation; verify host disk, backups, security, TLS ingress,
uptime and monitoring. capellanpc is only a proposed future test host; no server or account access,
app creation, live messages, deployment or production readiness is proved by this local mock.
