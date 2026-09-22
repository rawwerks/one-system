# /// script
# requires-python = ">=3.10"
# dependencies = ["typesafe-sdk==0.7.0", "PyYAML>=6.0.2,<7"]
# ///
"""Portable two-pass TypeSafe skill suggestion, not a gateway endpoint.

Run the public synthetic demo (no private library is discovered):
    TYPESAFE_ENDPOINT=http://127.0.0.1:8090 TYPESAFE_API_KEY=your-gateway-key \\
        uv run --no-project examples/skill_suggestion.py --model routing-demo 'Create a slide deck.'

--model is required and is passed on EVERY native API call.
For a private corpus, bind SKILLS_LIBRARY_PATH to a directory of SKILL.md files
or a roster JSON file, then explicitly pass --allow-private to permit inference.
Loading private files does NOT grant permission to transmit their content.
No paths or payloads are printed. Exit 0 means a portable ID or "no suggestion";
exit 2 means configuration, corpus, transport, or response failure, not abstention.

Canonical excerpt policy: normalize CRLF/CR to LF, strip outer whitespace,
then take the first 700 Unicode codepoints of the body. Descriptions are complete;
all roster entries participate in ranking. This policy never adapts to backend
limits: an unrepresentable request is an error, never a silently reduced roster.

A SKILL.md requires YAML frontmatter with string name and description. Its name
is its portable ID, independent of directory location; duplicate names fail.
Optional description_full and category are strings. Other standard skill metadata
is not projected. Directory traversal is deterministic and rejects symlinks.
JSON rosters use exactly id, description, description_full, body, and category.
Known private-root spellings in content are replaced with ${SKILLS_LIBRARY_PATH}
before storing/projecting text; this is root secrecy, NOT content anonymization.

Based on https://docs.typesafe.ai/cookbooks/skill_suggestion.md. See the public
synthetic corpus provenance.json for the deliberately non-benchmark data scope.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

SHORTLIST = 3
EXCERPT_CHARS = 700
GATE_THRESHOLD = 0.30
FITS_THRESHOLD = 0.30
PUBLIC_ROSTER = Path(__file__).with_name("skills") / "roster.json"
ROOT_PLACEHOLDER = "${SKILLS_LIBRARY_PATH}"
IDENTITY = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}\Z")
CHOICE_INSTRUCTIONS = (
    "Which of these skills, if any, is the right one to load to help with the "
    "user's latest request?"
)
RERANK_INSTRUCTIONS = (
    "Exactly one of these skills is the right one to load for the user's latest "
    "request. Which one? Read what each actually does, not just its name."
)
GATE_QUESTIONS = {
    "acts_on_user_system": (
        "Is the assistant being asked to act on the user's files, accounts, devices, "
        "or online services, rather than only to explain or advise?"
    ),
    "would_follow_documented_procedure": (
        "Would a careful expert answering this consult a specific documented procedure "
        "or set of commands, rather than answering from general understanding?"
    ),
    "prose_suffices": (
        "Could a knowledgeable generalist fully satisfy this request in prose, with "
        "no tools, no documentation, and no access to the user's files or accounts?"
    ),
}


class SuggestionError(Exception):
    """A sanitized application failure; never confused with a valid abstention."""


class ConfigurationError(SuggestionError):
    pass


class RosterError(SuggestionError):
    pass


class InferenceError(SuggestionError):
    pass


class AnswerError(SuggestionError):
    pass


@dataclass(frozen=True)
class Skill:
    id: str
    description: str
    description_full: str
    body: str
    category: str


def _identity_text(value: str) -> str:
    return value


@dataclass(frozen=True)
class Roster:
    skills: tuple[Skill, ...]
    private: bool = True
    # Only a callable is retained, never a serializable path field. Public skill
    # records already contain sanitized text. Do not pickle private loader state.
    _redact: Callable[[str], str] = field(default=_identity_text, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not isinstance(self.skills, tuple) or not self.skills:
            raise RosterError("The roster must contain at least one skill.")
        if type(self.private) is not bool:
            raise RosterError("The roster privacy flag must be a boolean.")
        seen: set[str] = set()
        normalized = []
        for skill in self.skills:
            if not isinstance(skill, Skill):
                raise RosterError("The roster contains an invalid skill record.")
            values = _validate_record(vars(skill))
            if skill.id in seen:
                raise RosterError("The roster contains duplicate portable skill IDs.")
            seen.add(skill.id)
            normalized.append(Skill(**{key: self._redact(value) for key, value in values.items()}))
        object.__setattr__(self, "skills", tuple(sorted(normalized, key=lambda skill: skill.id)))


def _text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise RosterError("Skill metadata and body fields must be nonempty strings.")
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def _validate_record(record: Any) -> dict[str, str]:
    fields = {"id", "description", "description_full", "body", "category"}
    if not isinstance(record, dict) or set(record) != fields:
        raise RosterError("Roster records require id, description, description_full, body, and category.")
    values = {key: _text(record[key]) for key in fields}
    if not IDENTITY.fullmatch(values["id"]) or values["id"] != record["id"]:
        raise RosterError("Skill IDs must be portable lowercase names, not paths.")
    return values


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RosterError("Corpus metadata contains duplicate fields.")
        result[key] = value
    return result


def _root_redactor(source: Path, supplied: str) -> Callable[[str], str]:
    # A JSON roster's private root is its parent directory, not its filename.
    root = source if source.is_dir() else source.parent
    roots = {str(root.absolute()), str(root.resolve())}
    supplied_path = Path(supplied).expanduser()
    if source.is_file():
        supplied_path = supplied_path.parent
    if supplied_path.is_absolute() or supplied.startswith("~/"):
        roots.add(str(supplied_path))
    variants: set[str] = set()
    for value in roots:
        variants.update((value, value.replace("/", "\\"), value.replace("/", "\\/"), json.dumps(value)[1:-1]))
        variants.update((quote(value, safe=""), quote(value, safe="/")))
        variants.add(Path(value).as_uri())
    # Conservatively cover case variations, including mixed-case percent escapes.
    pattern = re.compile("|".join(re.escape(value) for value in sorted(variants, key=len, reverse=True) if value), re.IGNORECASE)

    def redact(text: str) -> str:
        return pattern.sub(lambda _: ROOT_PLACEHOLDER, text)

    return redact


def _parse_skill(document: str) -> dict[str, str]:
    try:
        import yaml
    except ImportError:
        raise ConfigurationError("Install the example dependencies with uv run --no-project examples/skill_suggestion.py.") from None

    class UniqueLoader(yaml.SafeLoader):
        pass

    def mapping(loader: Any, node: Any) -> dict[str, Any]:
        pairs = []
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=True)
            if not isinstance(key, str):
                raise RosterError("SKILL.md metadata field names must be strings.")
            pairs.append((key, loader.construct_object(value_node, deep=True)))
        return _unique_object(pairs)

    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    lines = document.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or lines[0] != "---":
        raise RosterError("Each SKILL.md requires YAML frontmatter with name and description.")
    closing = next((i for i in range(1, len(lines)) if lines[i] in ("---", "...")), None)
    if closing is None:
        raise RosterError("SKILL.md frontmatter is not terminated.")
    try:
        metadata = yaml.load("\n".join(lines[1:closing]), Loader=UniqueLoader)
    except RosterError:
        raise
    except Exception:
        raise RosterError("SKILL.md contains malformed YAML metadata.") from None
    if not isinstance(metadata, dict) or "name" not in metadata or "description" not in metadata:
        raise RosterError("SKILL.md requires string name and description metadata.")
    return {
        "id": metadata["name"],
        "description": metadata["description"],
        "description_full": metadata.get("description_full", metadata["description"]),
        "body": "\n".join(lines[closing + 1:]),
        "category": metadata.get("category", "uncategorized"),
    }


def load_roster(path: str | os.PathLike[str] | None = None, *, environ: Mapping[str, str] | None = None) -> Roster:
    """Load the public demo, an explicit JSON/directory, or SKILLS_LIBRARY_PATH.

    Every explicit path and env-bound corpus is private by default. Only the
    committed default is public. There is no home-directory search or fallback
    when a configured private library is missing or invalid.
    """
    environment = os.environ if environ is None else environ
    binding = environment.get("SKILLS_LIBRARY_PATH") if path is None else os.fspath(path)
    if binding is not None and not binding.strip():
        raise ConfigurationError("SKILLS_LIBRARY_PATH is empty; set a corpus location or unset it for the public demo.")
    private = binding is not None
    try:
        source = Path(binding).expanduser() if private else PUBLIC_ROSTER
        if not source.exists():
            raise RosterError("The configured skill corpus is missing; check SKILLS_LIBRARY_PATH.")
        if source.is_symlink():
            raise RosterError("Skill corpus symlinks are not supported; bind the actual corpus location.")
        redact = _root_redactor(source, binding) if private else _identity_text
        if source.is_dir():
            records = []

            def walk_error(_: OSError) -> None:
                raise RosterError("The configured skill corpus could not be read.")

            for directory, directories, files in os.walk(source, followlinks=False, onerror=walk_error):
                directories.sort()
                if any((Path(directory) / name).is_symlink() for name in directories):
                    raise RosterError("Skill corpus symlink directories are not supported.")
                if "SKILL.md" in files:
                    skill_path = Path(directory) / "SKILL.md"
                    if skill_path.is_symlink():
                        raise RosterError("SKILL.md symlinks are not supported.")
                    records.append(_parse_skill(skill_path.read_text(encoding="utf-8")))
        elif source.is_file() and source.suffix.lower() == ".json":
            records = json.loads(source.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
        else:
            raise RosterError("Bind a directory containing SKILL.md files or a JSON roster.")
        if not isinstance(records, list):
            raise RosterError("A JSON roster must be an array of skill records.")
        skills = []
        for record in records:
            values = _validate_record(record)
            # Redact before excerpting, so relocating a corpus cannot change the
            # excerpt boundary or reveal a partial root at that boundary.
            values = {key: redact(value) for key, value in values.items()}
            skills.append(Skill(**values))
        return Roster(tuple(skills), private=private, _redact=redact)
    except SuggestionError:
        raise
    except Exception:
        raise RosterError("The configured skill corpus could not be read; check its JSON or SKILL.md metadata and permissions.") from None


def _sdk() -> Any:
    try:
        import typesafe_sdk
    except ImportError:
        raise ConfigurationError("Install example dependencies with uv run --no-project examples/skill_suggestion.py.") from None
    if typesafe_sdk.__version__ != "0.7.0":
        raise ConfigurationError("This example requires typesafe-sdk==0.7.0; use its isolated uv script environment.")
    return typesafe_sdk


def make_client(
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    http_client: Any = None,
) -> Any:
    """Create the official SDK client; supplied httpx2 clients are owned/closed by it.

    The HTTP client seam allows deterministic native-JSON integration tests.
    No default hosted endpoint, dummy authentication, redirect, or retry is used.
    SDK wire logging is disabled for this privacy-sensitive application.
    """
    environment = os.environ if environ is None else environ
    endpoint = base_url if base_url is not None else environment.get("TYPESAFE_ENDPOINT")
    key = api_key if api_key is not None else environment.get("TYPESAFE_API_KEY")
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise ConfigurationError("Set TYPESAFE_ENDPOINT to the gateway's HTTP(S) origin.")
    try:
        parsed = urlsplit(endpoint)
        valid_endpoint = (
            parsed.scheme in ("http", "https") and parsed.hostname and
            parsed.username is None and parsed.password is None and
            parsed.path in ("", "/") and not parsed.query and not parsed.fragment and
            parsed.port != 0 and not any(character.isspace() for character in endpoint)
        )
    except ValueError:
        valid_endpoint = False
    if not valid_endpoint:
        raise ConfigurationError("TYPESAFE_ENDPOINT must be an HTTP(S) origin without credentials, path, query, or fragment.")
    if not isinstance(key, str) or not key.strip():
        raise ConfigurationError("Set TYPESAFE_API_KEY to the configured gateway API key.")
    sdk = _sdk()
    logging.getLogger("typesafe_sdk").disabled = True
    owns_http_client = http_client is None
    try:
        if http_client is None:
            import httpx2
            http_client = httpx2.Client(timeout=120.0, follow_redirects=False, trust_env=False)
        elif http_client.follow_redirects:
            raise ConfigurationError("The supplied HTTP client must not follow redirects.")
        return sdk.TypeSafeClient(
            api_key=key, base_url=endpoint.rstrip("/"), timeout=120.0,
            retry=sdk.RetryPolicy(max_retries=0), http_client=http_client,
        )
    except SuggestionError:
        raise
    except Exception:
        if owns_http_client and http_client is not None:
            http_client.close()
        raise ConfigurationError("The TypeSafe client could not be configured; check the example dependencies and gateway settings.") from None


def _probability(value: Any) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise AnswerError("Invalid model response: probability must be finite and between zero and one.")
    return float(value)


def _answers(client: Any, state: dict[str, str], questions: dict[str, Any], model: str) -> Mapping[str, Any]:
    sdk = _sdk()
    try:
        response = client.system_one(state=state, questions=questions, model=model, retry=sdk.RetryPolicy(max_retries=0))
    except sdk.TypeSafeAPIResponseValidationError:
        raise AnswerError("Invalid model response: SDK response validation failed.") from None
    except Exception:
        raise InferenceError("TypeSafe inference failed; check gateway availability, authentication, and backend capacity.") from None
    answers = getattr(response, "answers", None)
    if not isinstance(answers, Mapping) or set(answers) != set(questions):
        raise AnswerError("Invalid model response: missing or unexpected answers.")
    return answers


def _choice(answer: Any, ids: set[str]) -> tuple[str, dict[str, float]]:
    probabilities = getattr(answer, "probabilities", None)
    winner = getattr(answer, "choice", None)
    if (
        getattr(answer, "type", None) != "choice" or not isinstance(winner, str) or
        winner not in ids or not isinstance(probabilities, Mapping) or set(probabilities) != ids
    ):
        raise AnswerError("Invalid model response: malformed skill Choice.")
    _probability(getattr(answer, "confidence", None))
    values = {name: _probability(value) for name, value in probabilities.items()}
    if not math.isclose(sum(values.values()), 1.0, rel_tol=0.0, abs_tol=0.01):
        raise AnswerError("Invalid model response: Choice probabilities do not sum to one.")
    if values[winner] < max(values.values()):
        raise AnswerError("Invalid model response: selected Choice does not have maximum probability.")
    return winner, values


def _noul(answer: Any) -> float:
    if getattr(answer, "type", None) != "noul":
        raise AnswerError("Invalid model response: a gate answer is not a Noul.")
    return _probability(getattr(answer, "noul", None))


def suggest(
    request: str,
    *,
    roster: Roster,
    client: Any,
    model: str,
    allow_private: bool = False,
) -> str | None:
    """Return the second Choice's portable ID, or a genuine model abstention.

    Failure raises SuggestionError. The caller owns client lifetime. A private
    roster requires allow_private=True even when using an injected HTTP client.
    """
    if not isinstance(roster, Roster):
        raise RosterError("Load a validated roster before requesting a suggestion.")
    if roster.private and allow_private is not True:
        raise ConfigurationError("Private skill content is not authorized for inference; explicitly pass allow_private=True or --allow-private.")
    if not isinstance(request, str) or not request.strip():
        raise ConfigurationError("Provide a nonempty user request.")
    if not isinstance(model, str) or not model.strip() or roster._redact(model) != model:
        raise ConfigurationError("The model must contain a valid model name, not a private corpus path.")
    sdk = _sdk()
    state = {"request": roster._redact(request), "recent_context": ""}
    skills = {skill.id: skill for skill in roster.skills}
    questions = {
        "which": sdk.Choice(
            instructions=CHOICE_INSTRUCTIONS,
            criteria={name: skill.description for name, skill in skills.items()},
        )
    }
    questions.update({f"gate::{name}": sdk.Noul(instructions=text) for name, text in GATE_QUESTIONS.items()})
    wide = _answers(client, state, questions, model)
    _, probabilities = _choice(wide["which"], set(skills))
    gates = {name: _noul(wide[f"gate::{name}"]) for name in GATE_QUESTIONS}
    gate = (gates["acts_on_user_system"] + gates["would_follow_documented_procedure"] + (1.0 - gates["prose_suffices"])) / 3
    if gate < GATE_THRESHOLD:
        return None
    shortlist = sorted(probabilities, key=lambda name: (-probabilities[name], name))[:SHORTLIST]
    questions = {
        "which": sdk.Choice(
            instructions=RERANK_INSTRUCTIONS,
            criteria={name: f"{skills[name].description_full} — {skills[name].body[:EXCERPT_CHARS]}" for name in shortlist},
        )
    }
    for name in shortlist:
        questions[f"fits::{name}"] = sdk.Noul(instructions=(
            f"Does the skill '{name}' do the specific thing the user's request asks "
            f"for? It is described as: {skills[name].description_full}"
        ))
    reranked = _answers(client, state, questions, model)
    winner, _ = _choice(reranked["which"], set(shortlist))
    fits = [_noul(reranked[f"fits::{name}"]) for name in shortlist]
    # Cookbook contract: the BEST fit gates the Choice winner, not the best-fit
    # skill and not the winner's own fit. Disagreement is intentional.
    return winner if max(fits) >= FITS_THRESHOLD else None


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse's usual error echoes unrecognized arguments, possibly paths.
        raise ConfigurationError("Invalid arguments; use --help for the application interface.")


def main(argv: list[str] | None = None) -> int:
    parser = _ArgumentParser(prog="skill_suggestion", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("request", help="the user's current request")
    parser.add_argument("--model", required=True, help="configured automatic routing name or explicit backend ID")
    parser.add_argument("--allow-private", action="store_true", help="explicitly permit sending env-bound private skill content to the configured inference endpoint")
    try:
        args = parser.parse_args(argv)
        roster = load_roster()
        if roster.private and not args.allow_private:
            raise ConfigurationError("Private skill content requires --allow-private before inference.")
        with make_client() as client:
            selected = suggest(args.request, roster=roster, client=client, model=args.model, allow_private=args.allow_private)
        print(selected if selected is not None else "no suggestion")
        return 0
    except SuggestionError as error:
        print(f"skill_suggestion: {error}", file=sys.stderr)
        return 2
    except Exception:
        print("skill_suggestion: Application failure; check example dependencies and gateway settings.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
