# Suggest a skill

[The skill example](../examples/skill_suggestion.py) ranks a roster and verifies shortlisted candidates through ordinary System One HTTP using pinned Python SDK `0.7.0`. There is no special gateway endpoint or Torch dependency for this application. Its bundled [synthetic roster](../examples/skills/roster.json) is a public demonstration, not a quality benchmark.

After `make setup-examples`, call a running gateway with its public key:

```sh
TYPESAFE_ENDPOINT=http://127.0.0.1:8090 \
TYPESAFE_API_KEY="$ONE_SYSTEM_API_KEY" \
  .build/example-venv/bin/python examples/skill_suggestion.py --model routing-demo 'Create a slide deck.'
```

The example CLI requires an explicit `--model`; it does not infer a demo route or use `TYPESAFE_MODEL`. This command assumes `backends.json` is running; choose the name advertised by your gateway (or a backend ID for direct dispatch) when using another registry. The client-side `TYPESAFE_API_KEY` in this command is the gateway key; the server's variable of the same name supplies the default hosted backend credential. Output is a portable skill ID or `no suggestion`; exit status `2` indicates an error rather than abstention.

For private skills, explicitly bind `SKILLS_LIBRARY_PATH` to a directory of `SKILL.md` files or a roster JSON file, and pass `--allow-private`. That opt-in permits roster names/descriptions and selected body excerpts to reach the configured inference endpoint. Replacing private-root paths does not anonymize their contents. Leave the binding unset to use the public demo. See the script's documentation for accepted metadata and deterministic excerpt rules.
