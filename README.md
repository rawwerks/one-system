# One System

**Use local and hosted decision models through one API.** One System sits between
your application and compatible [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one)
servers. Send your data and questions once; choose a backend directly or let a
model help decide where the request should run.

These models return decisions your code can use: **Choice** selects an option,
**Noul** gives the probability of yes, and **Score** rates against levels you
define. They return typed answers and probabilities, rather than writing a chat
reply.

Use One System to:

- Keep one client interface while trying different models or hosting arrangements.
- Handle suitable tasks locally and send other tasks to hosted Jev.
- Run entirely locally by choosing a configuration with no hosted backend.

The example below uses **local Laya to select between local Laya and hosted Jev**.
One System is the project; **Privacy Demo** is one example configuration you can
adapt. Its current rule classifies the task's domain, not whether the input
contains private information.

## Get started

Install the gateway on Linux or macOS (amd64/arm64):

```sh
curl -fsSL https://github.com/rawwerks/one-system/releases/latest/download/install.sh | sh
```

Review [the installer](scripts/install.sh) before trusting it. It verifies the selected
archive's checksum, installs under `~/.local/share/one-system`, and creates
`~/.local/bin/one-system`. It does not use sudo, start services, change shell
profiles, or overwrite an existing installation or launcher. See
[installation options](docs/binary-install.md) to inspect the installer first, pin a
version, choose destinations, or install from local bundles.

Then choose your setup guide:

- [Getting started on Linux](docs/getting-started-linux.md)
- [Getting started on macOS](docs/getting-started-macos.md)

No Go installation or compiler is needed to run the gateway. Local Laya runs
as a separate service with its own adapter and model checkpoint.

## Try the local router

The guides start Laya locally on port 8091 and the gateway on port 8090, using
the `privacy-demo` configuration. This demo also needs a TypeSafe API key for
requests it sends to hosted Jev; those calls can incur charges.

### Send your first question

In a new terminal, return to the installed gateway directory and load the
configuration you created in the setup guide:

```sh
set -a; . ./.env; set +a
```

Ask a simple question using automatic routing:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $ONE_SYSTEM_API_KEY" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:8090/v1/systemone \
  --data-binary '{
    "model": "privacy-demo",
    "state": "Please refund the duplicate charge for my subscription.",
    "questions": {
      "refund_requested": {
        "type": "noul",
        "instructions": "Does the customer request a refund?"
      }
    }
  }'
```

The response contains `answers.refund_requested.noul`, the probability of yes,
and `model`, the backend's model identity. In the gateway terminal, the `route`
log identifies which backend handled the request.

To try the demo's math escalation rule, send this second request:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $ONE_SYSTEM_API_KEY" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:8090/v1/systemone \
  --data-binary '{
    "model": "privacy-demo",
    "state": "17 + 25 = 42",
    "questions": {
      "correct": {
        "type": "noul",
        "instructions": "Is the arithmetic calculation correct?"
      }
    }
  }'
```

For these small requests, Laya first judges the domain of your **question
instructions**. The [demo rule](examples/privacy.backends.json) sends the full
request to Jev when Laya assigns `math_or_logic` a probability above 0.5; otherwise
Laya answers it locally. The [routing question](examples/routing.questions.json)
and threshold are editable examples. Inspect your results rather than assuming
either example always takes a particular route.

**Privacy Demo is not a privacy filter.** It does not inspect the input for
sensitive data, and a request with only one eligible backend skips model-based
selection, even if that backend is hosted. Use the [local-only configuration](examples/local.backends.json)
with `model: "local-demo"` when requests must stay local. See
[routing and disclosure](docs/configuration.md#routing-and-disclosure) before
adapting the mixed demo to real data.

## Choose another example

Set `ONE_SYSTEM_CONFIG` in `.env`, reload it, restart the gateway, and use the corresponding
`model` in your requests. Each gateway process loads one configuration.

| Example | Configuration | Use it for |
| --- | --- | --- |
| `privacy-demo` | `examples/privacy.backends.json` | Local task selection with rule-based hosted escalation |
| `local-demo` | `examples/local.backends.json` | Local Laya only; no hosted key needed |
| `routing-demo` | `backends.json` | Hosted selection across local and hosted backends |
| `jev-lint` | `examples/jev-lint.backends.json` | Hosted code-review judgments with a pinned Jev model |

Or set a request's `model` to a backend ID such as `local` or `hosted` to bypass
selection. A direct call does not silently substitute another backend.

### Laya + Jev, then Jev adjudication

[`examples/laya_jev_ensemble.py`](examples/laya_jev_ensemble.py) composes three native
System One requests using the official async Python SDK. Laya and Jev answer the
same questions concurrently; Jev then sees the original evidence and both typed
judgments and answers those original questions again. The gateway stays unchanged.

Start [local Laya](docs/local-laya.md) and a gateway configured with both `local`
and `hosted` backends (`backends.json` or `examples/privacy.backends.json`).
Then, from the repository root:

```sh
make setup-examples
TYPESAFE_ENDPOINT=http://127.0.0.1:8090 TYPESAFE_API_KEY="$ONE_SYSTEM_API_KEY" \
  .build/example-venv/bin/python examples/laya_jev_ensemble.py \
  --laya-model local --jev-model hosted --output .build/ensemble-demo
```

Use the gateway's API key here, not the hosted TypeSafe key. Both model arguments
are explicit backend IDs, bypassing automatic selection. The versioned
[`laya-jev-ensemble.json`](examples/laya-jev-ensemble.json) contains only public
synthetic input and the adjudication instructions. Two requests go to hosted Jev
and may incur charges; this is a feasibility example, not evidence of better accuracy.

Stdout is one standard `{model, answers, usage}` response: composite identity
`laya-jev-ensemble-v1`, the adjudicator's answers, and summed usage from all three
responses. Optional `--output` must name a new directory; it retains stage
request/response bodies, timing/model provenance, and the final result, but no
headers or credentials. Omit it to print only the final response. Failed or
invalid stages stop the example without retries, fallback, or a partial answer.
An unsuccessful output directory contains an incomplete report and whatever
stage bodies were available before failure; it never contains a final response.

## Build your own configuration

Give your registry a `name`, list compatible HTTP backends, and choose your
selector and fallback. The [configuration guide](docs/configuration.md) explains
credentials, routing rules, and adding an external server. The native API uses
`POST /v1/systemone`; there is no chat-completions endpoint.

<!-- true-up:anchor id=capability-constraints -->
Optional backend `capabilities` declare hard constraints: `question_types`,
`max_questions`, `min_criteria`, `max_criteria`, and `structured_state`.
`question_types` is required when capabilities are declared; `structured_state:
false` means string state only. Constraints apply to the actual request on every
route, including selection and fallback. Unsupported requests return HTTP 422
`unsupported_capability`; questions are not dropped, truncated, or reinterpreted.
Omitted capabilities mean unknown. Backend servers still validate their exact
model and context limits. See [configuration](docs/configuration.md#adding-a-backend)
for the JSON format.
<!-- true-up:end id=capability-constraints -->

Decision caching and full request/response recording are optional and off until
configured. Cache identical requests to avoid repeated inference; enable recording
to retain gateway and upstream exchanges, including cache hits and failures.
They can be used separately or together. Recording contains sensitive bodies and
has its own retention policy, independent of cache eviction. See
[cache configuration](docs/configuration.md#optional-decision-cache) and
[recording configuration](docs/configuration.md#optional-request-and-response-recording).

## Build from source or use another runtime

With Go 1.23 or newer, Git, and Make installed (repository access is currently
required):

```sh
git clone --recurse-submodules https://github.com/rawwerks/one-system.git
cd one-system
make setup build
```

Run `bin/one-system` instead of `./one-system` in the setup guides.
An independent [Hono implementation](docs/hono.md) supports Node and Cloudflare
Workers with the same HTTP interface and configurations.

## Work with your coding agent

Give your agent the [One System user skill](skills/one-system/SKILL.md) for using
this gateway and its examples. It points to TypeSafe's separately maintained
skill; follow the [official TypeSafe installation instructions](https://docs.typesafe.ai/agent-skill#installation)
to load that skill in your agent too.

## Explore further

- [Suggest a skill](docs/skill-suggestion.md): combine ranking and verification through the same API.
- [Review a repository before making it public](docs/public-release-review.md): read every non-ignored file from many angles in one request per chunk.
- [Review a backend integration](examples/integrations/README.md): check a candidate server before adding it.
- [TypeSafe questions and primitives](https://docs.typesafe.ai/primitives): design typed decisions for your application.
- [Contribute](CONTRIBUTING.md): development setup, mandatory local checks, and local-first releases; hosted workflows run only on explicit request.

## License

One System is available under the [MIT License](LICENSE). Two things in this
repository belong to TypeSafe and are not covered by it: the
[OpenAPI description](schema/README.md) of the System One API, and the
[TypeSafe skill](third_party/typesafe-skills), a pinned submodule under its own
MIT license.
