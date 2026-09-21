# TypeSafe API description

`typesafe.openapi.json` is TypeSafe's OpenAPI description of the System One HTTP
API. It is TypeSafe's work, not this project's, and this project's MIT license
does not cover it. It is kept here unmodified so that both gateways validate
requests and responses against the same published contract; the Go gateway
embeds it and the Hono build generates its validators from it.

[`source.json`](source.json) records where and when it was retrieved, its
upstream SHA-256, and the SDK versions it was checked against. Refresh it
deliberately from that URL rather than editing it. See
[TypeSafe's documentation](https://docs.typesafe.ai) and
[legal terms](https://docs.typesafe.ai/legal) for the API itself.
