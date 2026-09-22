# Configure One System

The default [registry](../backends.json), named `routing-demo`, configures local Laya at `http://127.0.0.1:8091` and hosted Jev, with hosted selection. Choose a registry according to the policy and destinations you want:

| Automatic `model` | Registry path | Routing policy | Requirements beyond the gateway key |
| --- | --- | --- | --- |
| `routing-demo` | `backends.json` | Mixed local/hosted; hosted selector | Running local Laya, `LOCAL_API_KEY`, `TYPESAFE_API_KEY` |
| `privacy-demo` | `examples/privacy.backends.json` | Local task selector and fallback; rule-based hosted escalation, with singleton routing still possible | Running local Laya, `LOCAL_API_KEY`, `TYPESAFE_API_KEY`; review disclosure limits below |
| `local-demo` | `examples/local.backends.json` | Local-only, single backend; no selector inference | Running local Laya and `LOCAL_API_KEY`; English-only checkpoint |
| `simple-jev-demo` | `examples/simple-jev.backends.json` | Single external Simple Jev backend; Choice/Score only | `SIMPLE_JEV_API_KEY`, reachable public demo; availability and quotas may change |
| `jev-lint` | `examples/jev-lint.backends.json` | Single hosted evaluator pinned to `jev-1.13.0` | `TYPESAFE_API_KEY`; submitted source leaves this machine |

For a prebuilt bundle, set `ONE_SYSTEM_CONFIG` to the chosen path, export the required credentials, and run `./one-system` from the extracted directory. For a source checkout, set the path in `.env`, then run `make serve` or `make serve-hono`. These targets source `.env`, whose assignments override shell-prefixed values. Every row also requires `ONE_SYSTEM_API_KEY`; all configured backend credentials are required even when a request might not use a backend. The names and paths are examples, not new project identities.

### Registry names and migration

Every registry must declare a top-level `name` string matching `^[A-Za-z0-9_-]+$`, distinct from every backend `id` in that registry. Startup rejects a missing, empty, null, non-string, malformed, or colliding name. Choose a name deliberately; there is no default name and no implicit or compatibility `one-system` alias. An operator can explicitly choose `one-system` if it satisfies the same rules, but it has no special meaning.

To migrate an existing registry, add its chosen `name`, restart the gateway, and update clients' `model` fields to that exact name for automatic routing. Direct backend IDs and upstream `model` values keep their existing meaning. Discover the active name with authenticated `GET /v1/models`: it is listed first, followed by sorted backend IDs. A configuration rename requires updating automatic-route clients; changing a filename alone does not rename its route. The project name, executable `one-system`, `ONE_SYSTEM_*` variables, SDK `SystemOne` types, and `/v1/systemone` protocol path are unchanged.

Supply these environment variables before starting the default registry:

| Variable | Purpose |
| --- | --- |
| `ONE_SYSTEM_API_KEY` | Bearer key clients use to call this gateway |
| `LOCAL_API_KEY` | Credential shared by the gateway and local Laya adapter |
| `TYPESAFE_API_KEY` | Credential for the hosted backend in the default registry |
| `ONE_SYSTEM_CONFIG` | Registry filename; defaults to `backends.json` |
| `ONE_SYSTEM_ADDR` | Listen address; defaults to `127.0.0.1:8090` |

Use separate terminals for the local adapter and either gateway implementation:

The blank [`.env.example`](../.env.example) lists configuration variables. Follow the owner-only copy instructions in [CONTRIBUTING.md](../CONTRIBUTING.md), fill values locally, and keep private registries or requests under the ignored `.local/` directory.

```sh
# Optional local backend: requires an already downloaded, complete checkpoint.
make setup-laya
export LAYA_MODEL_PATH=/path/to/existing/checkpoint
make serve-laya
```

```sh
# Go
make serve
```

```sh
# Or Hono on Node, using the same registry and environment.
make serve-hono
```

The Laya adapter disables checkpoint downloads. `LAYA_ADDR` defaults to `127.0.0.1:8091`; `LAYA_THREADS` defaults to `4`. A registry with a single backend works without a selector inference call, but `selector` must still name that backend. Every configured backend requires its named credential at startup.

The Go, Node, and Laya serve targets source `.env` if present. Keep credentials untracked and restrict that file to its owner; these targets execute it as shell code, so only use a file you trust.

All API routes, including capability discovery, require the gateway bearer key:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $ONE_SYSTEM_API_KEY" \
  http://127.0.0.1:8090/v1/models

curl --fail-with-body \
  -H "Authorization: Bearer $ONE_SYSTEM_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/english.json \
  http://127.0.0.1:8090/v1/systemone
```

The English request uses `routing-demo`; update its `model` if you chose another registry. These calls use the configured backends and can incur hosted inference charges. [The English example](../examples/english.json) and [multilingual example](../examples/multilingual.json) both use `routing-demo`, matching `backends.json`. When serving another registry, select its model explicitly rather than sending the unchanged payload. For example, with `examples/privacy.backends.json` running:

```sh
jq '.model = "privacy-demo"' examples/english.json |
  curl --fail-with-body \
    -H "Authorization: Bearer $ONE_SYSTEM_API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    http://127.0.0.1:8090/v1/systemone
```

The payloads show the native question format; [the pinned OpenAPI document](../schema/typesafe.openapi.json) defines the complete API. There is no chat-completions endpoint.

## Start a custom configuration

Here is a complete single-backend registry using the hosted TypeSafe endpoint:

```json
{
  "name": "my-setup",
  "selector": "hosted",
  "backends": [
    {
      "id": "hosted",
      "base_url": "https://api.typesafe.ai",
      "model": "jev-latest",
      "api_key_env": "TYPESAFE_API_KEY",
      "description": "Hosted TypeSafe Jev"
    }
  ]
}
```

Save it as `custom.backends.json` in your extracted bundle directory. In a source
checkout, use the ignored `.local/custom.backends.json` instead. Export
`ONE_SYSTEM_API_KEY` and `TYPESAFE_API_KEY`, then run from the bundle directory:

```sh
ONE_SYSTEM_CONFIG=custom.backends.json ./one-system
```

Use `model: "my-setup"` for that configuration's route or `model: "hosted"` to
call its backend directly. A singleton still requires `selector` naming the
backend, even though it does not perform selection inference.

For another compatible server, replace `base_url` and `model` with its endpoint
and native model name, give it a useful `description`, and name its credential's
environment variable in `api_key_env`. Use HTTPS except for loopback HTTP.
The registry stores credential variable names, never credential values. Every
configured credential must be nonempty at startup.

`capabilities` is optional. Declare limits only after verifying the server's
actual support; omitting them means unknown, not unlimited or certified support.

## Adding a backend

A compatible HTTP server needs a registry entry and contract fixtures, with no
model-specific gateway code. Use the backend `id` in the SDK's `model` field to
invoke it directly; the registry's `name` selects automatic routing. Direct calls
skip the selector and soft preferences and never substitute another backend.
The response reports the native upstream model identity.


Optional `capabilities` declare hard constraints, for example:

```json
{"question_types": ["choice", "score"], "min_criteria": 2, "max_criteria": 50}
```

Supported fields are `question_types` (required when capabilities are declared),
`max_questions`, `min_criteria`, `max_criteria`, and `structured_state` (`false`
means string state only). Constraints apply to each actual request, including
selector requests and every fallback path. Unsupported requests return HTTP 422
`unsupported_capability`; nothing is dropped, truncated or reinterpreted.
Native servers remain responsible for exact token/context and model-specific
validation. Omitted capabilities mean unknown, preserving older registries.



`GET /v1/models` lists the configured automatic routing name followed by sorted
backend IDs using the unchanged official SDK shape. A gateway routing entry's
`release_date` describes routing support, not a claimed checkpoint release date. The authenticated
`GET /v1/capabilities` extension returns `{"version":1,"models":[...]}` with
`name` and declared `capabilities` (or `null` for unknown). It exposes no URLs or
credentials and does not certify declarations.

The [Simple Jev example](../examples/simple-jev.backends.json) demonstrates an
independent public server registered for Choice/Score only. Its confidence is
maximum candidate probability. Noul is deliberately excluded because that
server documents a different support-score computation. The example is opt-in;
public-demo availability, quotas and model revisions can change.

Use the [integration workflow](../examples/integrations/README.md) to review a
candidate with One System and test native/gateway parity through the official
SDK. The candidate supplies the probe's target details; the local gate verifies
the complete saved evidence bundles before reporting readiness. Other HTTP
protocols may eventually need small isolated wire adapters;
there is no dynamic plugin loader or inference-engine abstraction to maintain.

## Routing and disclosure

Backend `limits` are legacy soft routing preferences: state length, non-ASCII letter fraction, question count, and widest criteria count. Eligibility is computed before selection. A single eligible backend receives the original request directly, even when it is hosted and differs from the fallback. If soft hints exclude every candidate, only backends satisfying hard capabilities are restored. Limits are not privacy or authorization controls.

With multiple candidates, the default selector sees question definitions and size/script metadata. Legacy selection includes original state only when the selector is also the configured fallback. A configured fallback handles selector failure; `escalation_confidence` can keep low-confidence legacy decisions there. Leaf inference failures do not trigger another backend call or retry.

The [privacy routing example](../examples/privacy.backends.json), named `privacy-demo`, uses local selection and fallback, with versioned [task questions](../examples/routing.questions.json). `privacy-demo` names this example policy, not One System itself and not a blanket privacy guarantee. The selector receives caller question instructions as task text, and a rule escalates to hosted inference when its answer is strictly above the configured threshold. This feature mode uses its rules rather than `escalation_confidence`:

```sh
# Set ONE_SYSTEM_CONFIG=examples/privacy.backends.json in .env first.
make serve
```

Question instructions and criteria can themselves contain private data. Omitting original state from selection is not anonymization; the chosen leaf receives the full request. The privacy example can still route directly to hosted inference through singleton eligibility. Configure trusted destinations according to the data you intend to disclose.

## Optional decision cache

Caching is disabled until an operator configures storage. Go and Hono on Node
use `ONE_SYSTEM_CACHE_PATH`, a private local SQLite file; Workers use the
`ONE_SYSTEM_CACHE_DB` D1 binding. Go and Node can replay each other's entries.
An explicit deployment epoch is required:

```sh
ONE_SYSTEM_CACHE_PATH=.local/decisions/cache.sqlite \
ONE_SYSTEM_CACHE_EPOCH=deployment-v1 make serve
```

Use `make serve-hono` for Node. Parent directories created by the gateway are
0700; preexisting parents must already be private. Database files and sidecars
must be 0600. Keep both cache and recording stores out of version control.

| Setting | Meaning |
| --- | --- |
| `ONE_SYSTEM_CACHE_MODE` | `off`, `readwrite`, or `replay`; defaults to `off` without storage, `readwrite` with storage |
| `ONE_SYSTEM_CACHE_NAMESPACE` | Key partition, default `default` |
| `ONE_SYSTEM_CACHE_EPOCH` | Required when enabled; change after model/adapter changes not represented in configuration |
| `ONE_SYSTEM_CACHE_TTL` | Default `1h`; Go-duration syntax, minimum `1ms`, maximum `8760h`; hits do not extend expiry |
| `ONE_SYSTEM_CACHE_MAX_BYTES` | Default `67108864`; positive stored-response-byte budget up to `1099511627776`, excluding SQLite/index/WAL overhead |

Keys cover exact request bytes, namespace, deployment epoch and a revision of
routing configuration, credentials, question assets and schema. Whitespace or
key order changes miss safely. Authentication, request validation and hard
capability checks run before lookup. Only validated successful decisions are
stored. A hit skips both selector and leaf inference and reports zero **new**
input/output tokens; it does not reproduce the original billed usage.

`X-One-System-Cache: bypass` skips reads and writes; `replay` reads only and
returns 404 `cache_miss` when no unexpired entry exists. Server replay mode
rejects bypass. Enabled gateways return `X-One-System-Cache: hit`, `miss`,
`bypass`, or `error` once a request reaches the cache. With caching off, this
header is ignored and not returned: **a replay header alone cannot guarantee
no inference on a host without caching.**

Expired and oldest-written entries are evicted. Responses larger than the
budget or the 8 MiB serialized replay limit are not stored; encoding can make a
response larger than its upstream body. D1 also refuses entries above its
2,000,000-byte row limit. Online cache failures fall through to ordinary inference; replay-only
read failures return 503. Identical misses coalesce within one process/isolate,
not across independent gateways. The cache is an optimization, not a history
or accounting system: it stores hashed keys and replay responses, not inputs.

## Optional request and response recording

Recording is separately opt-in and works with or without caching. It preserves
application exchanges for inspection and accounting instead of evicting them
when cached decisions expire. Go and Node use a separate private SQLite file:

```sh
ONE_SYSTEM_LOG_PATH=.local/history/exchanges.sqlite make serve
```

`ONE_SYSTEM_LOG_MODE` accepts `off` or `record`: without storage it defaults to
`off`; configuring storage enables `record` unless explicitly disabled.
`record` without storage is invalid. Workers use `ONE_SYSTEM_LOG_BUCKET`, an R2
binding, rather than a filesystem path. Cache and recording paths must identify
different files, including their `-wal`, `-shm`, and `-journal` sidecars. For example,
`cache.sqlite` and `cache.sqlite-journal` are not independent stores and are rejected
before either is opened. Both features may be enabled together.

**Recording stores sensitive bodies.** It records gateway requests and generated
responses, including cache hits, bypasses, malformed requests and authentication
rejections, plus each actual selector/backend request and response. Upstream
error bodies are retained privately even though public errors stay sanitized.
Original inference response bytes and token usage are never rewritten to replay
usage. A cache hit appends its own gateway response record with the zero new usage
actually returned; it does not create another backend exchange.
Authorization, Cookie and other headers, URL queries and raw transport exception
messages are not recorded. Secrets embedded by an application in bodies are
not automatically redacted. Choose who may access the store accordingly.

Each version-1 JSON record contains `id`, `request_id`, `exchange_id`, `kind`
(`request` or `response`), `scope` (`gateway`, `selector`, or `backend`),
`time` (Unix milliseconds), `method`, `path`, `body_base64` and `body_complete`.
Response records add `status`, and `cache`/`error` when applicable. Correlate by
request/exchange IDs, not timestamps or storage ordering. Body encoding preserves
bytes, including numeric spellings and invalid UTF-8. SQLite appends records to
`log_events`; R2 writes `logs/<request_id>/<id>.json`.

Recording obeys the gateway's 8 MiB body safety ceiling and deadlines. An
oversized, interrupted or unreadable body is explicitly marked
`body_complete: false`; only its captured prefix can be retained. It never
drains an unlimited stream to claim complete logging. Requests rejected by the
host HTTP parser before reaching the gateway cannot be recorded. A response
record describes what the gateway generated, not proof the client received it.

Writes are awaited: the request is committed before that exchange is executed,
and the response before it is returned. SQLite uses WAL and FULL synchronization.
A recording failure returns 503 `logging_unavailable`; it must not silently
continue inference or trigger selector fallback. Inference already performed
cannot be rolled back when recording its response fails; there is no automatic
retry. Crashes can leave a request without a response record, which represents
an incomplete exchange rather than a fabricated successful one.

There is no automatic recording expiry or size eviction. Provision capacity,
backups and an explicit retention policy (including any R2 lifecycle rules).
Deleting cached decisions never deletes history. The file-backed stores require
0700 directories and 0600 files/sidecars; Node's SQLite operations are synchronous,
so measure event-loop latency for large bodies or high concurrency. See
[Worker bindings](hono.md#cloudflare-workers) for deployment configuration.
