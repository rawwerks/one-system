# Run with Node or Cloudflare Workers

Hono is an independent gateway implementation with the same HTTP interface and registry format as the Go executable. It needs Node 24 and Bun. From a source checkout:

```sh
make setup-hono build-hono
make serve-hono
```

Configure `.env` as described in the [configuration guide](configuration.md). The serve target loads it automatically.

## Cloudflare Workers

[Worker configuration](../hono/wrangler.jsonc) uses runtime bindings instead of local files:

- `ONE_SYSTEM_API_KEY` and each registry `api_key_env` are runtime secret bindings.
- `ONE_SYSTEM_CONFIG_JSON` supplies raw registry JSON. Alternatively, `ONE_SYSTEM_WORKER_CONFIG` names a registry file to bundle at build time; never put credential values in it.
- Versioned routing questions are bundled. `ONE_SYSTEM_QUESTIONS_JSON` can override them with a JSON object mapping asset names to raw JSON strings.
- Optional `ONE_SYSTEM_CACHE_DB` is a D1 database binding for the decision cache.
  Enabling it requires `ONE_SYSTEM_CACHE_EPOCH`; cache mode, namespace, TTL and
  byte-budget variables have the same meaning as on Go/Node.
- Optional `ONE_SYSTEM_LOG_BUCKET` is an R2 bucket binding for sensitive exchange
  history. `ONE_SYSTEM_LOG_MODE=off` disables it; a configured bucket otherwise
  enables recording. R2 holds one JSON object per request/response event so
  accepted bodies are not limited by D1's per-row ceiling.

Add only the bindings for features you intend to enable:

```jsonc
"d1_databases": [
  { "binding": "ONE_SYSTEM_CACHE_DB", "database_name": "one-system-decisions", "database_id": "<your database ID>" }
],
"r2_buckets": [
  { "binding": "ONE_SYSTEM_LOG_BUCKET", "bucket_name": "one-system-history" }
],
"vars": {
  "ONE_SYSTEM_CACHE_EPOCH": "deployment-v1"
}
```

Create and bind your own resources; nothing is provisioned automatically.
Without these bindings the features are off. Filesystem `*_PATH` settings do
not provision Worker storage. Cache expiry does not remove R2 history; configure
bucket access and retention deliberately. Recording writes are awaited before
inference/response delivery, not deferred through `waitUntil`. See the
[recording contract](configuration.md#optional-request-and-response-recording)
for incomplete bodies, privacy and write-failure behavior.

A deployed Worker cannot reach a Laya server on your workstation's loopback interface. Its registry needs backends reachable from the Worker. `make check-worker` checks packaging only; account bindings, deployment, and live Worker validation are separate operations.

`make check-worker-local` runs the built Worker under local workerd against
synthetic loopback backends. It checks authentication, singleton routing,
credential isolation, exact JSON preservation, UTF-8 request framing, HTTP 407
sanitization and no retry after HTTP 421. With local D1/R2 bindings it also checks
cache miss/hit/bypass, durable full-exchange recording, rejected requests,
upstream error bodies, fail-closed recording, large bodies, restart and
independent retention, plus D1 byte-budget enforcement under large-entry pressure.
It is not deployed-cloud or full routing/cancellation
conformance. Artifacts remain in ignored `.build/scenarios/` directories.
