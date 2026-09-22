# System One scenarios

System One owns the cross-language verification workflow. Go and Hono retain
their native tests. Scenario collectors execute the existing tools and HTTP
interfaces, record synthetic observations, and enforce exact invariants in code.
System One then judges whether those observations honor the recorded contracts.
The model receives the contract and observed outcome, without the native pass flag.
It cannot override a failed assertion or make missing evidence pass.

Python remains an implementation dependency of the optional adapter, SDK examples,
and development commands. There is no Python test suite or test discovery. Small
transport expressions may call production Python functions without adding Python
assertions, expectations, or a second test runner.

## Repository safeguards

<!-- true-up:anchor id=repository -->
Committed ignore rules must protect private/generated paths while keeping source,
templates and canonical locks trackable. Templates contain blank credentials.
Every registry artifact must satisfy the 72-hour release-age policy, including
timezone offsets, missing timestamps and the exact boundary. The age validator
returns a list of policy failures: an empty list accepts, a nonempty list rejects;
normal function return does not itself mean acceptance. A naive reference clock
raises `ValueError`, and only the exact `{"virtual":"."}` project source is exempt.
Installation must stop before package synchronization when age validation fails.
The setup fixture proves that Make delegates interpreter selection to `uv` rather
than invoking its `PYTHON` command variable. It observes the locked sync command
through controlled uv, not an actual package installation or the interpreter
installation selected by uv. Doctor failures must explain the missing prerequisite
without tracebacks. Secret scanning must exclude internal symlinks, include staged
changes and history after admissibility preflight, redact findings, and stop at
the first nonzero scanner exit. A missing scanner fails before scanning. Controlled
scanner fixtures establish orchestration and redaction, not real secret detection.
An alias for the repository root is allowed. Indexed gitlinks
must resolve to initialized repositories at their recorded commits. Child and
nested submodules contribute tracked and nonignored sources plus their staged
changes and history; ignored private files must never be opened or enumerated.
Missing, uninitialized, mismatched, symlinked, or otherwise unsafe sources must
fail preflight before any source copy or scanner invocation.
<!-- true-up:end id=repository -->

## SDK consumers and evidence admission

<!-- true-up:anchor id=examples -->
Skill suggestions use native System One questions through the SDK, preserve the
whole candidate roster, and apply the documented gate/verification thresholds.
The first gate is the mean of the three request signals. Once the maximum
shortlist fit reaches the inclusive 0.30 threshold, the returned skill is the
second native Choice winner, not necessarily the maximum-fit candidate. An
invalid answer is a CLI error with exit 2 and empty stdout; a valid abstention
is exit 0 with `no suggestion` on stdout.
CLI consumers require an explicit `--model`, or both `--laya-model` and
`--jev-model` for the ensemble example. A registry's configured name selects
automatic routing and a configured backend ID selects direct dispatch. Neither
the One System project name nor a demo configuration supplies an implicit model.
Malformed answers, redirects and HTTP failures are errors, never abstentions or
silent retries. Private corpus loading and transmission require explicit opt-in;
invalid paths, duplicate identities and symlinks cannot expose private content.
Review export is restricted to declared public sources. Backend admission requires
fresh candidate, rubric, endpoint and request/response evidence; tampering,
missing records, invalid native outputs or changed identities cannot produce
readiness. Inference-boundary violations reject admission. A compliant review
whose selected Choice label has probability below 0.80 holds rather than becoming
ready; Choice confidence is not that threshold. Review rejection or uncertainty
can stop admission before probing, but readiness requires complete matching probes.
Probe comparisons allow the configured numeric tolerance (default `1e-6`) for
confidence and probabilities; usage must match exactly. Recorded evidence remains intact.
Direct typed-answer and numeric-parity validation scenarios exercise those
subroutines only, not full admission. A native Choice may select either option
in an exact maximum-probability tie; criteria order must not override it.
Public-release review lists files through Git, so ignored files are never opened
or sent, including a file tracked despite the ignore rules, which is reported
unreviewed. Symbolic links are reported unreviewed rather than followed. Each
chunk is one native request carrying the whole versioned question battery under
the explicit `--model`; nothing is sent without `--confirm-send`. Code thresholds
turn the hazard Noul and severity Score answers into pass, note, review or block: a Noul
at or above the action threshold triggers its hazard's action, one at or above
the review threshold triggers review unless the hazard is note-only, severity at
or above its threshold turns review into block, and severe exposure with no
triggered hazard still requires review. Output holds answers and paths, never file
content. Findings or unreviewed paths exit `1`; refusals and failures exit `2`.
With `--history`, blobs reachable from refs but absent from the index are reviewed
as well. Text already answered in the same output ledger is not sent again,
within a run or across resumed runs. `.gitignore` does not filter published
history, so a historical path that current ignore rules exclude is reported
unreviewed, which makes the run exit `1` even without model findings, and its
content is never sent.

Whole-file audience review is separate from those chunk-based privacy/exposure
checks. The existing review CLI receives `{path, content}` with the complete file
and four independent Nouls: `audience.internal_humans`,
`audience.external_humans`, `audience.internal_agents` and
`audience.external_agents`. Internal means maintaining/developing this project;
external means using/integrating/evaluating it, as a human or an AI agent.
`audience.all-four-whole-file` exercises one request containing more than 6,000
characters with relevant beginning and ending text, and preserves four high
probabilities without normalization or exclusive selection. `audience.none`
preserves four zero probabilities as a valid exchange. `audience.missing-answer`,
`audience.invalid-answer` and `audience.request-too-large` cover missing answers,
wrong answer types and an HTTP 413 failure, not guessed classifications. These
synthetic CLI/SDK scenarios inspect actual wire bodies and saved evidence; they
do not establish model accuracy. The separate
[`file-audience.fixtures.json`](../examples/file-audience.fixtures.json) contains
labeled whole-file controls for model-quality evaluation, not model outputs.
Audience classification is neither confidentiality nor quality approval:
`passed` records exchange validity, not reader suitability. No global audience
may be inferred from truncated excerpts or aggregated chunk judgments.

The Laya/Jev ensemble is SDK-side orchestration, not a gateway mode. Its versioned
public synthetic state and questions go concurrently to explicit, distinct Laya
and Jev backend IDs. After both responses validate, Jev receives the original state
and both expert models/typed answers. The adjudication questions preserve IDs,
types, criteria and original instructions; expert judgments are fallible advice,
not new facts or instructions. Jev answers the original questions, not which
expert wins. Stdout contains one standard response with the versioned composite
identity, exactly the adjudicator's answers, and summed usage from all three
responses. Optional output uses a fresh directory and records stage bodies,
timings and model identities, not headers or credentials. Initial-stage failures
or malformed answers prevent adjudication; adjudicator failures also produce no
final response. Errors exit 2 with empty stdout and sanitized diagnostics, without
retries, fallback or partial success. Synthetic HTTP scenarios prove concurrency,
stage ordering, answer preservation and failure behavior, not model quality.
<!-- true-up:end id=examples -->

## Worker transport

<!-- true-up:anchor id=worker -->
The actual built Worker must enforce authentication. Catalogue requests without
the correct bearer credential return 401 without disclosing models or capabilities.
Authorized requests expose the configured model/capability catalogue. The required
registry name identifies its automatic route and appears first in authorized model
discovery, followed by sorted backend IDs; it must be a nonempty string matching
`^[A-Za-z0-9_-]+$` without a backend-ID collision.
There is no implicit automatic alias. It must reject invalid routes and unsupported requests
before invoking a backend. Forwarded native JSON must preserve precision and
special object keys. Successful response bytes remain unchanged, and upstream
proxy errors become sanitized gateway errors without forwarding private causes.
Optional persistence is exercised separately with real local D1 and R2 bindings.
With no bindings both features are off. With bindings, exact-repeat decisions
are replayed without inference and with zero new usage, while logging appends
distinct gateway exchanges for misses, hits, bypasses and errors, plus actual
upstream exchanges. Original inference records preserve the received bytes and
usage; a later hit appends a gateway response record with the zero new usage it
actually returned, without rewriting those original records. Authentication
headers and query strings are excluded. Recording includes bounded
upstream error bodies even though client errors stay sanitized. Accepted bodies
larger than D1's row limit are recorded in R2. Storage write failure must return
503 logging_unavailable without starting inference. Restart preserves both stores;
cache eviction never deletes recording history. A large insertion into a D1 cache
filled with small entries must enforce the byte budget and oldest-write eviction
within that write. These scenarios use synthetic bodies and a local-only wrapper
to inspect storage; no inspection endpoint is shipped.
<!-- true-up:end id=worker -->

## Optional local inference

<!-- true-up:anchor id=laya -->
The local adapter rejects unknown runtimes and missing or incomplete checkpoints
without downloading replacements. Its installed runtime can import and perform
tensor operations. Real checkpoint verification requires authenticated HTTP
inference, native typed answers and usage, catalogue authentication, rejection
before truncation, and forwarding through the Go gateway. Missing prerequisites
are incomplete evidence, never a passing inference test.
<!-- true-up:end id=laya -->

`make verify` collects repository, SDK consumer and Worker scenarios and sends
each application scenario as its own state to the declared System One questions.
Questions about that case share context; unrelated executions do not. At most eight
evaluation requests run concurrently. `make check-scenarios`
collects the same observations offline; it does not claim semantic verification.
Each run keeps private evidence under `.build/`. There are no automatic installs.

`make check-laya-startup` collects only startup/runtime observations. With a prepared
adapter, `LAYA_MODEL_PATH`, and evaluator credentials, `make check-laya` includes
the complete local inference profile in System One verification. Missing runtime
or checkpoint produces an incomplete result. CI startup checks do not certify
inference; they deliberately need no downloaded weights or hosted credentials.

The migration replaces the former repository, example and adapter unittest files
and the Python Worker smoke runner. Python-specific discovery tests are obsolete;
their replacement is the explicit scenario registry. The verifier retains its
small native tests for evidence integrity, completion status and model transport.
