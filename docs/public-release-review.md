# Review a repository before making it public

[The public-release example](../examples/public_release_review.py) asks a System One model to read every file Git would publish and reports what a person should look at before a private repository becomes public. It uses ordinary System One HTTP through the pinned Python SDK `0.7.0`; there is no special gateway endpoint.

Files come from Git, so `.gitignore` is respected: tracked files plus untracked files that are not ignored. Ignored files such as `.env` are never opened, even when someone force-added one to the index: it is listed as unreviewed instead. Symbolic links and submodules are listed as unreviewed rather than followed. Each file is split on line boundaries into small chunks, which keeps unrelated text out of each judgment and ties a finding to a line range.

## One request, many angles

Every chunk is one request that carries the whole [versioned question battery](../examples/public-release.questions.json). The questions look at the same text independently and cannot see each other's answers:

| Angle | Questions |
| --- | --- |
| What leaks | `leak.secret`, `leak.local_path`, `leak.personal_data`, `leak.private_infrastructure`, `leak.recorded_run`, `leak.confidential_business` |
| Internal/private-context hazards | `audience.internal_notes`, `audience.assumes_private_access` |
| How it reads to outsiders | `reputation.disparaging_remark`, `reputation.admits_unfinished_work` |
| What helps an attacker | `security.unfixed_weakness` |
| Whose work it is | `ownership.third_party_material` |
| How bad exposure would be | the `severity.exposure` Score |

Each hazard is a Noul: the probability that the condition holds. The model never sees the policy. Code compares each probability with a review threshold (`0.35`) and an action threshold (`0.70`), maps a triggered hazard to `block`, `review` or `note`, lets a severity Score of `2.0` or more turn a `review` into a `block`, and reports the highest action per file. These numbers are starting points from the [guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails.md); evaluate them on cases you know and change them with `--review-threshold`, `--action-threshold` and `--severity-block`. Changing a threshold does not require new inference: rerun with the same `--output` and recorded answers are reused.

Exact lookups stay in code, not in questions: files that are tracked although ignored, files that contain this checkout's or your home directory's absolute path, and whether the repository root has a license file.

Reader fit is a separate [whole-file audience review](../examples/integrations/README.md#review-who-a-whole-file-is-written-for),
used when it matters: four independent Nouls for internal/external humans and
agents, not a single intended-reader choice. Internal means maintaining or
developing the project; external means using, integrating or evaluating it.
Several audiences, all four, or none may apply. Classification is not
confidentiality or quality approval and adds no release gate. The privacy/exposure
checks here remain chunk-based; do not infer a file's audience from excerpts or
aggregate chunk answers. Whole-file review requires the complete text and reports
request-limit failures rather than silently truncating it.

## Run it

Plan first. This lists files and chunks and sends nothing:

```sh
python3 examples/public_release_review.py --dry-run
```

Then, after `make setup-examples`, review through a running gateway. The [pinned review registry](../examples/jev-lint.backends.json) sends every request to hosted `jev-1.13.0`:

```sh
TYPESAFE_ENDPOINT=http://127.0.0.1:8090 \
TYPESAFE_API_KEY="$ONE_SYSTEM_API_KEY" \
  .build/example-venv/bin/python examples/public_release_review.py --model jev-lint \
  --confirm-send --output "$HOME/scratch/one-system-public-release"
```

`--confirm-send` acknowledges that the content of every listed file is sent to the configured endpoint; with a hosted backend that content leaves your machine. Use a registry containing only trusted local backends to keep it local. `--model` is required: use the name your gateway advertises, or a backend ID for direct dispatch. `--repo` reviews a different working tree.

`--output` must be outside the repository or ignored by it. It receives `chunks.jsonl` (answers, paths, line ranges and token usage, never file content) and `report.json`. Rerunning with the same output resumes: text already answered for the same questions and model is not sent again. The report's `measured_input_tokens` is the sum of the usage the gateway returned; multiply it by your backend's price yourself.

Exit status `0` means every file was reviewed and passed, `1` means there are findings or unreviewed paths, and `2` means a configuration, transport or response failure left the run incomplete.

## Review history too

Making a repository public publishes more than the working tree: earlier versions, deleted files, every branch and tag, and any notes refs that were pushed. Add `--history` to review every blob that is reachable from a ref but is not already in the index:

```sh
python3 examples/public_release_review.py --dry-run --history
```

Identical text is judged once, however many versions, paths or refs contain it, so history costs far less than its raw size. Each blob is attributed to the first ref that reaches it, with remote-tracking refs first, then tags, branches and notes. A finding under `refs/remotes/` is something a remote already holds; one under `refs/heads/` or `refs/notes/` would be published only by a later push. Findings name the oldest commit that touches the blob. `--history-refs PREFIX` (repeatable) narrows the refs, for example `--history-refs refs/remotes/origin/` to review only what the remote holds.

`.gitignore` does not filter history, so a path that is ignored today may still be published with an old commit. Such paths are listed as unreviewed and under `ignored_paths_in_history`, and their content is never sent.

## What this does not cover

Release assets, issues, pull requests, submodule contents and objects that exist only on a remote are not read; review them separately. Without `--history`, neither is anything outside the working tree. A hosting service can keep commits that a force-push made unreachable, so rewriting history does not by itself prove that old objects are gone. Answers are review signals for a person. A pass is not clearance to publish, and typed output guarantees the interface, not the truth of a judgment.
