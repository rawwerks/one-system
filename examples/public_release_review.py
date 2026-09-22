# /// script
# requires-python = ">=3.10"
# dependencies = ["typesafe-sdk==0.7.0"]
# ///
"""Review every non-ignored file before flipping a private repository public.

Plan first; nothing is read into a request and no HTTP is sent:
    python3 examples/public_release_review.py --dry-run [--history]

Review through a running gateway (see docs/public-release-review.md):
    TYPESAFE_ENDPOINT=http://127.0.0.1:8090 TYPESAFE_API_KEY=your-gateway-key \\
        uv run --no-project examples/public_release_review.py --model jev-lint \\
        --confirm-send --output "$HOME/scratch/one-system-public-release"

Files come from Git, so .gitignore is respected: tracked files plus untracked
files that are not ignored. Ignored files such as .env are never opened.
Each file is split on line boundaries. Every chunk is ONE native request that
carries the whole versioned battery in public-release.questions.json; the
questions look at the same text from independent angles and cannot see each
other's answers. Code, not the model, combines them into pass, note, review or
block using the thresholds below. Identical text is judged once, under the
first path that contains it.

--history also reviews every blob reachable from any ref that is not already in
the index: earlier versions, deleted files, other branches, tags, stashes and
notes. Publishing a repository publishes all of that. Each blob is attributed to
the first ref that reaches it, remote-tracking refs first, so the report shows
what a remote already holds. --history-refs PREFIX (repeatable) narrows the
refs. A historical path that the current ignore rules exclude is listed as
unreviewed and its content is never sent.

--confirm-send acknowledges that the content of every listed file is sent to the
configured endpoint. With a hosted backend that content leaves this machine.
--output must be outside the repository or ignored by it. It receives
chunks.jsonl (answers and usage, never file content) and report.json. Rerunning
with the same output resumes: text already answered for the same questions and
model is not sent again.

Scope: the working tree, plus Git objects with --history. Release assets,
issues, pull requests, submodule contents and objects that exist only on a
remote are NOT reviewed. Answers are review signals, never clearance to publish.
Exit 0: everything reviewed and passed. Exit 1: findings or unreviewed paths.
Ignored content is never sent: a file tracked despite the ignore rules, or an
ignored path found in history, is listed as unreviewed instead.
Exit 2: configuration, transport or response failure; the run is incomplete.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import math
import os
import stat
import subprocess
import sys
from collections.abc import Iterator, Mapping
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

QUESTIONS = Path(__file__).with_name("public-release.questions.json")
CHUNK_CHARS = 6000
MAX_FILE_BYTES = 2 * 1024 * 1024
# Starting points taken from the guardrails cookbook's strict policy. They are
# examples to evaluate against known cases, not calibrated guarantees.
REVIEW_THRESHOLD = 0.35
ACTION_THRESHOLD = 0.70
SEVERITY_BLOCK = 2.0
SEVERITY = "severity.exposure"
HAZARD_ACTION = {
    "leak.secret": "block",
    "leak.local_path": "review",
    "leak.personal_data": "review",
    "leak.private_infrastructure": "review",
    "leak.recorded_run": "review",
    "leak.confidential_business": "review",
    "audience.internal_notes": "review",
    "audience.assumes_private_access": "review",
    "reputation.disparaging_remark": "review",
    "reputation.admits_unfinished_work": "note",
    "security.unfixed_weakness": "review",
    "ownership.third_party_material": "review",
}
PRECEDENCE = ("block", "review", "note", "pass")  # Highest precedence wins.
# A blob reachable from several refs is attributed to the most published one.
REF_ORDER = ("refs/remotes/", "refs/tags/", "refs/heads/", "refs/notes/")
STATE_FIELDS = ("path", "lines", "content")
WORKTREE_SCOPE = (
    "Working tree only: tracked files plus untracked files that are not ignored. Git history, "
    "other branches, tags, notes refs, release assets, issues, pull requests and submodule "
    "contents were not reviewed. Answers are review signals, not clearance to publish."
)
HISTORY_SCOPE = (
    "Working tree plus every blob reachable from the selected local refs. Release assets, issues, "
    "pull requests, submodule contents and objects that exist only on a remote were not reviewed. "
    "Answers are review signals, not clearance to publish."
)


class ReviewError(Exception):
    """A sanitized failure; never confused with a finding."""


def load_questions(path: Path = QUESTIONS) -> dict[str, Any]:
    try:
        questions = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ReviewError("The question battery could not be read.") from None
    # The policy below names every question. A renamed or added question must
    # get an explicit action here instead of silently never affecting a verdict.
    if not isinstance(questions, dict) or set(questions) != {*HAZARD_ACTION, SEVERITY}:
        raise ReviewError("The question battery does not match the policy in this example.")
    if any(questions[name].get("type") != "noul" for name in HAZARD_ACTION):
        raise ReviewError("Every hazard question must be a Noul.")
    if questions[SEVERITY].get("type") != "score":
        raise ReviewError("The severity question must be a Score.")
    return questions


def _git(root: Path, *arguments: str, stdin: bytes | None = None, separator: bytes = b"\0",
         accept: tuple[int, ...] = (0,)) -> list[str]:
    try:
        done = subprocess.run(["git", "--no-pager", *arguments], cwd=root, timeout=120, input=stdin,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        done = None
    if done is None or done.returncode not in accept:
        raise ReviewError("Git could not list the repository; run inside a Git working tree.")
    return [os.fsdecode(item) for item in done.stdout.split(separator) if item]


def list_files(root: Path) -> tuple[list[str], dict[str, str], list[str], set[str]]:
    """Return reviewable paths, unreviewable paths, ignored-but-tracked paths, and index blob IDs.

    Git applies .gitignore, .git/info/exclude and the global excludes file, so
    this never discovers ignored files such as .env or build output.
    """
    skipped: dict[str, str] = {}
    paths: set[str] = set()
    indexed: set[str] = set()
    # A force-added file is still ignored content: never open it, and say so.
    tracked_ignored = sorted(_git(root, "ls-files", "-z", "--cached", "--ignored", "--exclude-standard"))
    for entry in _git(root, "ls-files", "-z", "--stage"):
        meta, _, path = entry.partition("\t")
        mode, oid = meta.split(" ")[:2]
        indexed.add(oid)
        if path in tracked_ignored:
            skipped[path] = "tracked although ignore rules exclude it; content not sent"
        elif mode == "160000":
            skipped[path] = "submodule; review the upstream repository separately"
        elif mode == "120000":
            skipped[path] = "symbolic link; not followed"
        else:
            paths.add(path)
    paths.update(_git(root, "ls-files", "-z", "--others", "--exclude-standard"))
    return sorted(paths), skipped, tracked_ignored, indexed


def list_history(root: Path, prefixes: list[str], indexed: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Return blobs reachable from refs but absent from the index, and ignored historical paths.

    History is not filtered by .gitignore when a repository is published, so an
    ignored path found here is a finding. Its content is still never sent.
    """
    refs = [ref for ref in _git(root, "for-each-ref", "--format=%(refname)", separator=b"\n")
            if not prefixes or any(ref.startswith(prefix) for prefix in prefixes)]
    refs.sort(key=lambda ref: (next((i for i, p in enumerate(REF_ORDER) if ref.startswith(p)), len(REF_ORDER)), ref))
    found: dict[str, dict[str, Any]] = {}
    for ref in refs:
        for line in _git(root, "rev-list", "--objects", ref, separator=b"\n"):
            oid, _, path = line.partition(" ")
            if path and oid not in found and oid not in indexed:
                found[oid] = {"oid": oid, "path": path, "ref": ref}
    if not found:
        return [], []
    sizes = _git(root, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                 stdin="\n".join(found).encode() + b"\n", separator=b"\n")
    blobs = []
    for line in sizes:
        oid, kind, size = line.split(" ")
        if kind == "blob":
            blobs.append({**found[oid], "bytes": int(size)})
    if not blobs:
        return [], []  # Only trees were new: every historical blob is already in the index.
    names = sorted({blob["path"] for blob in blobs})
    ignored = set(_git(root, "check-ignore", "--no-index", "-z", "--stdin",
                       stdin="\0".join(names).encode() + b"\0", accept=(0, 1)))
    blobs.sort(key=lambda blob: (refs.index(blob["ref"]), blob["path"], blob["oid"]))
    excluded = [{k: blob[k] for k in ("path", "ref", "oid")} for blob in blobs if blob["path"] in ignored]
    return [blob for blob in blobs if blob["path"] not in ignored], excluded


def _text(raw: bytes) -> str:
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("larger than the per-file limit")
    if b"\0" in raw:
        raise ValueError("binary content")
    return raw.decode("utf-8")


def read_text(root: Path, relative: str) -> str:
    """Open each path component without following symbolic links."""
    parts = PurePosixPath(relative).parts
    if not parts or PurePosixPath(relative).is_absolute() or any(part in {".", ".."} for part in parts):
        raise ValueError("not a repository-relative path")
    if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
        raise ReviewError("Safe collection requires no-follow directory-relative opens.")
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("not a regular file")
            raw = stream.read(MAX_FILE_BYTES + 1)
    finally:
        os.close(directory)
    return _text(raw)


def read_blob(root: Path, blob: Mapping[str, Any]) -> str:
    if blob["bytes"] > MAX_FILE_BYTES:
        raise ValueError("larger than the per-file limit")
    try:
        done = subprocess.run(["git", "--no-pager", "cat-file", "blob", blob["oid"]], cwd=root, timeout=120,
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        raise ValueError("could not be read from the object database") from None
    return _text(done.stdout)


def chunk(text: str, limit: int = CHUNK_CHARS) -> Iterator[tuple[int, int, str]]:
    """Yield (first_line, last_line, text) pieces of at most limit characters.

    Smaller states keep unrelated text out of each judgment and localize a
    finding to a line range. A single over-long line is split on its own.
    """
    first, size, lines = 1, 0, []
    for number, line in enumerate(text.splitlines(keepends=True), 1):
        if lines and size + len(line) > limit:
            yield first, number - 1, "".join(lines)
            first, size, lines = number, 0, []
        if len(line) > limit:
            for offset in range(0, len(line), limit):
                yield number, number, line[offset:offset + limit]
            first = number + 1
            continue
        lines.append(line)
        size += len(line)
    if lines:
        yield first, first + len(lines) - 1, "".join(lines)


def plan(root: Path, limit: int = CHUNK_CHARS, history: bool = False, prefixes: list[str] | None = None) -> dict[str, Any]:
    paths, skipped, tracked_ignored, indexed = list_files(root)
    work: list[dict[str, str]] = []
    private_roots: list[dict[str, str]] = []
    # Exact lookups belong in code: the model is not asked to find these strings.
    markers = {str(root), str(Path.home())} - {"/", ""}

    def add(label: str, path: str, text: str, extra: Mapping[str, str]) -> None:
        if any(marker in text for marker in markers):
            private_roots.append({"path": label, **{k: v for k, v in extra.items() if k != "oid"}})
        for first, last, piece in chunk(text, limit):
            if piece.strip():
                work.append({"label": label, "path": path, "lines": f"{first}-{last}", "content": piece, **extra})

    def reason(error: Exception) -> str:
        if isinstance(error, UnicodeDecodeError):
            return "not UTF-8 text"
        if isinstance(error, FileNotFoundError):
            return "listed by Git but missing from the working tree"
        return str(error) if isinstance(error, ValueError) else "could not be opened safely"

    for relative in paths:
        try:
            add(relative, relative, read_text(root, relative), {"source": "worktree"})
        except ReviewError:
            raise
        except (OSError, ValueError) as error:
            skipped[relative] = reason(error)
    blobs, excluded = list_history(root, prefixes or [], indexed) if history else ([], [])
    for entry in excluded:
        skipped[f"{entry['path']}@{entry['oid'][:10]}"] = f"ignored by current rules yet reachable from {entry['ref']}; content not sent"
    for blob in blobs:
        label = f"{blob['path']}@{blob['oid'][:10]}"
        try:
            add(label, blob["path"], read_blob(root, blob), {"source": "history", "ref": blob["ref"], "oid": blob["oid"]})
        except ValueError as error:
            skipped[label] = f"{reason(error)}; reachable from {blob['ref']}"
    return {"files": paths, "history_blobs": len(blobs), "chunks": work, "unreviewed": skipped, "history": history, "checks": {
        "tracked_but_ignored": tracked_ignored,
        "ignored_paths_in_history": excluded,
        "contains_this_checkout_or_home_path": private_roots,
        "license_file_present": any(PurePosixPath(p).name.upper().startswith(("LICENSE", "LICENCE", "COPYING"))
                                    and "/" not in p for p in paths),
    }}


def decide(answers: Mapping[str, Any], policy: Mapping[str, float]) -> dict[str, Any]:
    """Turn one chunk's raw answers into an action. The model never sees this policy."""
    triggered: dict[str, str] = {}
    for hazard, action in HAZARD_ACTION.items():
        probability = answers[hazard]["noul"]
        if probability >= policy["action_threshold"]:
            triggered[hazard] = action
        elif probability >= policy["review_threshold"] and action != "note":
            triggered[hazard] = "review"
    severity = answers[SEVERITY]["score"]
    if severity >= policy["severity_block"]:
        triggered = {name: "block" if action == "review" else action for name, action in triggered.items()}
        # Severe exposure that no named hazard explains still deserves a person's attention.
        triggered.setdefault(SEVERITY, "review")
    action = next(level for level in PRECEDENCE if level in triggered.values() or level == "pass")
    return {"action": action, "triggered": triggered, "severity": severity}


def _probability(value: Any) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ReviewError("The model returned an invalid probability.")
    return float(value)


def plain_answers(questions: Mapping[str, Any], answers: Any) -> dict[str, Any]:
    """Validate typed SDK answers and keep only JSON values needed by decide()."""
    if not isinstance(answers, Mapping) or set(answers) != set(questions):
        raise ReviewError("The model returned missing or unexpected answers.")
    result: dict[str, Any] = {}
    for name, question in questions.items():
        answer, kind = answers[name], question["type"]
        if getattr(answer, "type", None) != kind:
            raise ReviewError("The model returned an answer of the wrong type.")
        if kind == "noul":
            result[name] = {"noul": _probability(answer.noul)}
            continue
        expected = set(question["criteria"]) if kind == "choice" else {str(i) for i in range(len(question["criteria"]))}
        probabilities = {str(key): _probability(value) for key, value in answer.probabilities.items()}
        if set(probabilities) != expected:
            raise ReviewError("The model returned an invalid probability distribution.")
        result[name] = {"probabilities": probabilities, "confidence": _probability(answer.confidence)}
        if kind == "choice":
            result[name]["choice"] = answer.choice
        else:
            score = answer.score
            if type(score) not in (int, float) or not math.isfinite(score):
                raise ReviewError("The model returned an invalid score.")
            result[name]["score"] = float(score)
    return result


def make_client(environ: Mapping[str, str] | None = None) -> Any:
    """Official async SDK client for the gateway: no proxies, redirects, or wire logging."""
    environment = os.environ if environ is None else environ
    endpoint, key = environment.get("TYPESAFE_ENDPOINT", ""), environment.get("TYPESAFE_API_KEY", "")
    try:
        url = urlsplit(endpoint)
        valid = (url.scheme in ("http", "https") and url.hostname and url.username is None and url.password is None
                 and url.path in ("", "/") and not url.query and not url.fragment
                 and (url.scheme == "https" or url.hostname in {"localhost", "127.0.0.1", "::1"}))
    except ValueError:
        valid = False
    if not valid:
        raise ReviewError("Set TYPESAFE_ENDPOINT to the gateway origin: HTTPS, or loopback HTTP.")
    if not key.strip() or any(character.isspace() for character in key):
        raise ReviewError("Set TYPESAFE_API_KEY to the configured gateway API key.")
    try:
        import httpx2
        import typesafe_sdk as sdk
    except ImportError:
        raise ReviewError("Install the example dependencies with uv run --no-project examples/public_release_review.py.") from None
    logging.getLogger("typesafe_sdk").disabled = True
    # Retries stay on the same origin and honor retry-after for 429 and 529.
    return sdk.AsyncTypeSafeClient(
        api_key=key, base_url=endpoint.rstrip("/"), retry=sdk.RetryPolicy(max_retries=4),
        http_client=httpx2.AsyncClient(timeout=180.0, follow_redirects=False, trust_env=False))


def content_key(item: Mapping[str, str], battery: str, model: str) -> str:
    """Identical text is judged once, however many paths, versions or refs contain it."""
    material = json.dumps([model, battery, item["content"]], ensure_ascii=False)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def battery_digest(questions: Mapping[str, Any]) -> str:
    return hashlib.sha256(json.dumps(questions, ensure_ascii=False).encode("utf-8")).hexdigest()


async def review(work: list[dict[str, str]], questions: dict[str, Any], *, model: str, client: Any,
                 ledger: Path, concurrency: int) -> tuple[dict[str, dict[str, Any]], int]:
    """Send one request per distinct chunk, each carrying the whole battery. Append answers as they arrive."""
    battery = battery_digest(questions)
    done: dict[str, dict[str, Any]] = {}
    if ledger.exists():
        text = ledger.read_text(encoding="utf-8")
        if text and not text.endswith("\n"):
            with ledger.open("a", encoding="utf-8") as stream:
                stream.write("\n")  # Keep the next record off a line cut short by an interrupted run.
        for line in text.splitlines():
            try:
                record = json.loads(line)
                done[record["key"]] = record
            except (ValueError, KeyError, TypeError):
                continue  # A line cut short by an interrupted run is simply not answered yet.
    pending: dict[str, dict[str, str]] = {}
    for item in work:
        pending.setdefault(content_key(item, battery, model), item)
    gate, failures = asyncio.Semaphore(concurrency), 0

    async def one(key: str, item: dict[str, str]) -> None:
        nonlocal failures
        async with gate:
            try:
                response = await client.system_one(state={name: item[name] for name in STATE_FIELDS},
                                                   questions=questions, model=model)
                record = {"key": key, "path": item["path"], "lines": item["lines"], "model": response.model,
                          "input_tokens": response.usage.input_tokens,
                          "answers": plain_answers(questions, response.answers)}
            except Exception:
                # SDK and transport errors may quote request content. Count, never print.
                failures += 1
                return
        done[key] = record
        with ledger.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")

    await asyncio.gather(*(one(key, item) for key, item in pending.items() if key not in done))
    return {key: done[key] for key in pending if key in done}, failures


def first_commit(root: Path, oid: str) -> str | None:
    """Oldest commit on any ref that adds or removes this blob; enough for a person to find it."""
    try:
        commits = _git(root, "log", "--all", "--format=%h", f"--find-object={oid}", separator=b"\n")
    except ReviewError:
        return None
    return commits[-1] if commits else None


def report(planned: Mapping[str, Any], records: Mapping[str, dict[str, Any]], policy: Mapping[str, float],
           model: str, failures: int, battery: str, root: Path | None = None) -> dict[str, Any]:
    findings, by_label, unanswered = [], {}, 0
    for item in planned["chunks"]:
        record = records.get(content_key(item, battery, model))
        if record is None:
            unanswered += 1
            continue
        decision = decide(record["answers"], policy)
        rank = PRECEDENCE.index(decision["action"])
        by_label[item["label"]] = min(by_label.get(item["label"], len(PRECEDENCE) - 1), rank)
        if decision["action"] != "pass":
            finding = {"path": item["label"], "lines": item["lines"], "source": item["source"], **decision, "signals": {
                name: round(record["answers"][name]["noul"], 3) for name in decision["triggered"] if name in HAZARD_ACTION}}
            if item["source"] == "history":
                finding["ref"] = item["ref"]
                finding["first_commit"] = first_commit(root, item["oid"]) if root is not None else None
            findings.append(finding)
    findings.sort(key=lambda f: (PRECEDENCE.index(f["action"]), -f["severity"], f["path"], int(f["lines"].split("-")[0])))
    files = {level: sorted(label for label, rank in by_label.items() if PRECEDENCE[rank] == level) for level in PRECEDENCE}
    return {
        "scope": HISTORY_SCOPE if planned["history"] else WORKTREE_SCOPE,
        "requested_model": model, "answered_by": sorted({r["model"] for r in records.values()}),
        "policy": dict(policy), "hazard_actions": HAZARD_ACTION,
        "totals": {"files_listed": len(planned["files"]), "history_blobs": planned["history_blobs"],
                   "chunks": len(planned["chunks"]), "distinct_chunks": len(records) + unanswered_distinct(planned, records, battery, model),
                   "chunks_unanswered": unanswered, "requests_failed": failures,
                   "measured_input_tokens": sum(r["input_tokens"] for r in records.values())},
        "code_checks": planned["checks"], "unreviewed": planned["unreviewed"],
        "files_by_action": files, "findings": findings,
    }


def unanswered_distinct(planned: Mapping[str, Any], records: Mapping[str, Any], battery: str, model: str) -> int:
    return len({content_key(item, battery, model) for item in planned["chunks"]} - set(records))


def _publishable(output: Path, root: Path) -> bool:
    """True when output lies in the repository and Git would not ignore it."""
    if output != root and root not in output.parents:
        return False
    try:
        # check-ignore exits 0 when ignored, 1 when not; anything else is unknown, so refuse.
        return subprocess.run(["git", "check-ignore", "-q", "--", str(output)], cwd=root, timeout=60,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
    except (OSError, subprocess.SubprocessError):
        return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="public_release_review", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1], help="repository root to review")
    parser.add_argument("--model", help="configured automatic routing name or explicit backend ID")
    parser.add_argument("--dry-run", action="store_true", help="list files and chunks; send nothing")
    parser.add_argument("--history", action="store_true",
                        help="also review every blob reachable from any ref that is not in the index")
    parser.add_argument("--history-refs", action="append", default=[], metavar="PREFIX",
                        help="with --history, only refs starting with PREFIX, such as refs/remotes/origin/; repeatable")
    parser.add_argument("--confirm-send", action="store_true",
                        help="acknowledge that every listed file's content is sent to the configured endpoint")
    parser.add_argument("--output", type=Path, help="evidence directory outside the repository, or ignored by it")
    parser.add_argument("--concurrency", type=int, default=8, help="requests in flight (default 8)")
    parser.add_argument("--chunk-chars", type=int, default=CHUNK_CHARS)
    parser.add_argument("--review-threshold", type=float, default=REVIEW_THRESHOLD)
    parser.add_argument("--action-threshold", type=float, default=ACTION_THRESHOLD)
    parser.add_argument("--severity-block", type=float, default=SEVERITY_BLOCK)
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.concurrency <= 64 or not 500 <= args.chunk_chars <= 60000:
            raise ReviewError("Use 1 to 64 concurrent requests and 500 to 60000 characters per chunk.")
        if args.history_refs and not args.history:
            raise ReviewError("--history-refs narrows --history; pass both.")
        root = args.repo.resolve(strict=True)
        questions = load_questions()
        battery = battery_digest(questions)
        planned = plan(root, args.chunk_chars, args.history, args.history_refs)
        if args.dry_run:
            distinct = {content_key(item, battery, "") for item in planned["chunks"]}
            print(json.dumps({"files": len(planned["files"]), "history_blobs": planned["history_blobs"],
                              "chunks": len(planned["chunks"]), "distinct_chunks": len(distinct),
                              "characters": sum(len(c["content"]) for c in planned["chunks"]),
                              "questions_per_request": len(questions), "unreviewed": planned["unreviewed"],
                              "code_checks": planned["checks"], "sent": False}, indent=2))
            return 0
        if not args.model or not args.confirm_send or args.output is None:
            raise ReviewError("A review needs --model, --confirm-send and --output; use --dry-run to plan without sending.")
        output = args.output.expanduser().resolve()
        if _publishable(output, root):
            raise ReviewError("--output must be outside the repository or ignored by it; reports describe private content.")
        output.mkdir(parents=True, exist_ok=True)
        policy = {"review_threshold": args.review_threshold, "action_threshold": args.action_threshold,
                  "severity_block": args.severity_block}

        async def run() -> tuple[dict[str, dict[str, Any]], int]:
            async with make_client() as client:
                return await review(planned["chunks"], questions, model=args.model, client=client,
                                    ledger=output / "chunks.jsonl", concurrency=args.concurrency)

        records, failures = asyncio.run(run())
        result = report(planned, records, policy, args.model, failures, battery, root)
        (output / "report.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        for finding in result["findings"]:
            signals = ", ".join(f"{name}={value}" for name, value in finding["signals"].items()) or "no hazard above threshold"
            where = f"  [{finding['ref']} since {finding['first_commit']}]" if finding["source"] == "history" else ""
            print(f"{finding['action']:6} {finding['path']}:{finding['lines']}  severity={finding['severity']:.2f}  {signals}{where}")
        print(json.dumps({"totals": result["totals"], "answered_by": result["answered_by"],
                          "files_by_action": {k: len(v) for k, v in result["files_by_action"].items()},
                          "unreviewed": len(result["unreviewed"]), "code_checks": result["code_checks"]}, indent=2))
        print(result["scope"], file=sys.stderr)
        if failures or result["totals"]["chunks_unanswered"]:
            print("public_release_review: some chunks were not answered; rerun with the same --output to resume.", file=sys.stderr)
            return 2
        if result["findings"] or result["unreviewed"]:
            print(f"public_release_review: exit 1: {len(result['findings'])} finding(s), "
                  f"{len(result['unreviewed'])} unreviewed path(s) need a person.", file=sys.stderr)
            return 1
        return 0
    except ReviewError as error:
        print(f"public_release_review: {error}", file=sys.stderr)
        return 2
    except Exception:
        print("public_release_review: Application failure; check example dependencies and gateway settings.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
