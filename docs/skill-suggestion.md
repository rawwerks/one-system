# Suggest a skill

[The skill example](../examples/skill_suggestion.py) ranks a roster and verifies shortlisted candidates through ordinary System One HTTP using pinned Python SDK `0.7.0`. There is no special gateway endpoint or Torch dependency for this application. Its bundled [synthetic roster](../examples/skills/roster.json) is a public demonstration, not a quality benchmark.

After `make setup-examples`, call a running gateway with its public key:

```sh
TYPESAFE_ENDPOINT=http://127.0.0.1:8090 \
TYPESAFE_API_KEY="$ONE_SYSTEM_API_KEY" \
  .build/example-venv/bin/python examples/skill_suggestion.py --model routing-demo 'Create a slide deck.'
```

The example CLI requires an explicit `--model`; it does not infer a demo route or use `TYPESAFE_MODEL`. This command assumes `backends.json` is running; choose the name advertised by your gateway (or a backend ID for direct dispatch) when using another registry. The client-side `TYPESAFE_API_KEY` in this command is the gateway key; the server's variable of the same name supplies the default hosted backend credential. Output is a portable skill ID or `no suggestion`; exit status `2` indicates an error rather than abstention.

The first request gates verification using the mean of its three request signals.
The second request returns its native Choice winner when the **maximum shortlist
fit** reaches the inclusive `0.30` threshold; it does not substitute the
highest-fit candidate or require that the winner's own fit reaches the threshold.
These signals serve different purposes, as recorded in the
[example provenance](../examples/skills/provenance.json).

When the first gate reaches `0.30`, verification uses up to three candidates,
ordered by descending first-stage Choice probability and then skill ID. A
one-entry roster still gets both stages. Verification supplies full descriptions
and up to 700 body Unicode codepoints after normalization and private-root
redaction. The provenance file describes the bundled public demo, not every
explicitly bound private corpus.

A valid abstention prints `no suggestion` and exits `0`. A malformed model response
leaves stdout empty, reports a sanitized validation error on stderr, and exits `2`;
callers must not treat that failure as an abstention.

For private skills, explicitly bind `SKILLS_LIBRARY_PATH` to a directory of `SKILL.md` files or a roster JSON file, and pass `--allow-private`. That opt-in permits roster names/descriptions and selected body excerpts to reach the configured inference endpoint. Replacing private-root paths does not anonymize their contents. Leave the binding unset to use the public demo. See the script's documentation for accepted metadata and deterministic excerpt rules.
