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
