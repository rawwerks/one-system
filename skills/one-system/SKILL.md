---
name: one-system
description: Configure and use the One System gateway from an application, connect compatible local or hosted TypeSafe backends, and adapt its routing examples. Use for One System setup or client integration; the upstream TypeSafe skill covers primitive and question design.
---

# Build with One System

Help an external user run and integrate One System. This skill covers the gateway;
it does not replace the upstream TypeSafe skill or the repository's developer guide.

## Load TypeSafe first

Before working on the integration, load and read the complete official
**typesafe-ai** skill. If it is not available, follow
[TypeSafe's official installation instructions](https://docs.typesafe.ai/agent-skill#installation)
for the user's agent environment, then load it. Choose one supported installation
method. Do not assume that installing a skill also loads it into the current task.

The [official skill source](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md)
is available for direct reading when needed. If neither the installed skill nor
the official source can be read, explain the missing prerequisite before proceeding.
This skill links to TypeSafe's maintained instructions; it does not bundle a copy.
Use the relevant live API/SDK and primitive documentation as the upstream skill directs.

## Choose a setup that fits the user

One System is an HTTP gateway, available as a Go executable or an independent
Hono application. It connects to inference servers; it does not install model
weights or start those servers. A prebuilt Go bundle runs without Go, Node, or
Python. A local Laya server has its own adapter and checkpoint setup.

Start with the user's existing endpoint and backend choices. For installation,
consult the [One System README](https://github.com/rawwerks/one-system/blob/main/README.md)
and its platform guides. Use the release-backed installer described in the
[binary installation guide](https://github.com/rawwerks/one-system/blob/main/docs/binary-install.md):
HTTPS downloads, or an authenticated GitHub CLI.
It installs the complete bundle and a user-local launcher without starting a
service or overwriting existing installations. Do not invent releases or URLs.
The launcher runs from the installed bundle directory; use absolute paths for
custom registries and their routing-question files. Source builds and Hono are
alternative setup paths.

The Go executable reads environment variables directly and does not load `.env`
automatically. Source-checkout `make serve` and `make serve-hono` load `.env` as
shell code, which can override exported settings. Run a bundle from its extracted
directory so configuration and routing-question paths resolve correctly.

## Keep the three model identities distinct

| Name | Meaning |
| --- | --- |
| Registry `name` | Request `model` for automatic routing under that configuration |
| Backend `id` | Request `model` for direct dispatch to that backend |
| Backend `model` | Native model identifier forwarded to that upstream server |

One System is the project name, not a universal automatic-routing alias. Each
registry requires a `name` containing ASCII letters, digits, underscores, or
hyphens, distinct from all of its backend IDs. Discover the running gateway's
actual names using authenticated `GET /v1/models`; do not assume a demo is loaded.
A direct backend request bypasses selection and never silently substitutes another
backend. Responses report the upstream model identity.

The included `privacy-demo`, `local-demo`, and `routing-demo` configurations are
examples, not upstream model names. Each gateway process loads one registry.
Select it with `ONE_SYSTEM_CONFIG`, then restart the process after editing it.
See the [configuration guide](https://github.com/rawwerks/one-system/blob/main/docs/configuration.md)
for the complete registry format.

## Connect the client and backends

- Clients call `POST /v1/systemone` with native `model`, `state`, and `questions`.
  Preserve Choice, Noul, and Score answers; this is not a chat-completions API.
- `ONE_SYSTEM_API_KEY` is the gateway's bearer key. All API routes require it,
  including model and capability discovery.
- Each backend requires `id`, `base_url`, native `model`, `api_key_env`, and
  `description`. The registry requires `selector`, even with only one backend. Supply every
  configured backend credential to the gateway, even when a request might not use it.
- Point the official SDK at the gateway's trusted base URL and authenticate with
  the gateway key. Select the intended route or backend explicitly on each call.
  Upstream provider keys remain in the gateway environment; clients do not need them.
- `GET /v1/capabilities` exposes declared backend limits. The gateway rejects
  unsupported requests rather than truncating them or converting question types.
  Missing capability declarations mean unknown support.

Keep credentials in the user's normal local secret mechanism, never in registry
JSON, copied examples, source control, or diagnostic output. Backend registry
entries store environment variable names, not key values.

For an already running local endpoint, this is a complete registry shape; replace
the example URL and upstream model with the user's actual values:

```json
{
  "name": "local-only",
  "selector": "local",
  "backends": [{
    "id": "local",
    "base_url": "http://127.0.0.1:8091",
    "model": "your-upstream-model",
    "api_key_env": "LOCAL_API_KEY",
    "description": "Trusted local decision service"
  }]
}
```

Supply `ONE_SYSTEM_API_KEY` and `LOCAL_API_KEY` in the gateway environment and
select this file with `ONE_SYSTEM_CONFIG`. Use HTTPS for non-loopback endpoints.
If confidential and hosted requests need strict separation, use separate local-only
and hosted-only gateway configurations/listeners and direct the application to the
appropriate endpoint deliberately; the local-only gateway has no hosted destination.

## Adapt routing deliberately

For data that must stay local, use a registry containing only trusted local
backends. The current Privacy Demo uses local Laya to classify **question
instructions** by task domain and can escalate the full request to hosted Jev.
It is not a sensitive-data detector. Its name does not enforce a privacy policy.

Soft `limits` affect eligibility; a sole eligible backend receives the request
without a selector call, including when that backend is hosted. Hard
`capabilities` are checked on every route. With multiple candidates, selector
disclosure depends on the configured routing mode; question text itself can
contain private information. Review intended destinations before using real data.

Keep routing questions as editable, versioned artifacts and keep thresholds in
configuration. Apply the TypeSafe skill when designing judgments. Verify the
resulting route with representative examples rather than treating model confidence
as proof that a destination is appropriate.

## Optional caching and recording

Neither feature is required for a deployment. Enable the decision cache only
when wanted: `ONE_SYSTEM_CACHE_PATH` plus `ONE_SYSTEM_CACHE_EPOCH` on Go/Node,
or `ONE_SYSTEM_CACHE_DB` plus the epoch on Workers. A replay hit skips inference
and reports zero new tokens; it is not an accounting record.

For full application exchange history, separately configure `ONE_SYSTEM_LOG_PATH`
on Go/Node or `ONE_SYSTEM_LOG_BUCKET` on Workers. Recording includes sensitive
request/response bodies, upstream errors and distinct cache hits. It excludes
transport headers and query strings, not secrets embedded in application bodies.
Both features default off without storage; explicit `*_MODE=off` overrides storage.
Logs are not evicted with cached decisions. Explain storage/retention and the
fail-closed `logging_unavailable` behavior before enabling recording. Use
[the configuration contract](../../docs/configuration.md#optional-request-and-response-recording)
for body limits and completeness semantics.

## Verify the user's path

Check authenticated discovery first, then send a small synthetic native request.
Inspect the returned model and, for the Go gateway, its route log to confirm
the destination. Hono does not emit the same route log; use upstream request
traces when the returned model alone cannot distinguish destinations.
When changing routing, exercise local and hosted branches and verify that direct
dispatch bypasses the selector. Distinguish gateway behavior tested with mock
servers from the quality of real Laya/Jev judgments. Do not silently perform paid
inference or disclose private inputs as part of a synthetic setup check.

If setup fails, identify the boundary: gateway configuration/authentication,
backend availability or credentials, model capability, or the judgment itself.
Use the actual response and relevant logs without exposing credentials or input
content. Keep the user's application workflow in its existing language and stack.
