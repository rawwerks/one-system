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

A deployed Worker cannot reach a Laya server on your workstation's loopback interface. Its registry needs backends reachable from the Worker. `make check-worker` checks packaging only; account bindings, deployment, and live Worker validation are separate operations.

`make check-worker-local` runs the built Worker under local workerd against a synthetic loopback backend. It checks authentication, singleton routing, credential isolation, exact JSON preservation, UTF-8 request framing, HTTP 407 sanitization, and no retry after HTTP 421; it is not full Worker routing/cancellation conformance. Each run preserves its artifacts in `scratch/one-system-worker/` under the current user's home directory.
