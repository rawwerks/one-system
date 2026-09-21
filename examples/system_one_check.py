"""Evidence-producing HTTP checks. No inference engines, discovery, or installation.

review submits an explicit state and frozen rubric through the official SDK.
probe compares an independently served backend with its named gateway route.
gate combines candidate review with matching probe evidence; it never registers models.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
RUBRIC = ROOT / "examples/integration-review.questions.json"
FAILURES = {
    "missing_input": "A required input or evidence artifact is missing.",
    "invalid_json": "An input or evidence artifact is not valid JSON.",
    "input_too_large": "An input or evidence artifact exceeds 2 MiB.",
    "invalid_candidate": "Supply a named candidate with a target and supported question types.",
    "invalid_fixtures": "Supply 1 to 32 fixtures covering exactly the proposed question types.",
    "invalid_tolerance": "Tolerance must be finite and between zero and 0.01.",
    "invalid_answers": "Answers violate the requested native decision contract.",
    "choice_not_maximum": "A selected Choice must have maximum probability; ties are allowed.",
    "wire_mismatch": "Recorded HTTP bodies differ from the recorded request or response.",
    "review_mismatch": "Review evidence is stale, mismatched, or incomplete.",
    "probe_mismatch": "Probe evidence is stale, mismatched, or incomplete.",
    "parity_mismatch": "Native and gateway responses differ beyond the recorded tolerance.",
    "unexpected_model": "A response or model listing does not identify the expected model.",
    "invalid_endpoint": "Endpoints require HTTPS or loopback HTTP without credentials, query, or fragment.",
    "invalid_key": "A required key environment binding is missing or invalid.",
    "execution_failed": "Check failed; inspect the selected inputs and local evidence. No integration was activated.",
}


class CheckError(ValueError):
    """Only fixed, safe diagnostics may reach reports or stderr."""
    def __init__(self, code):
        self.code = code
        super().__init__(FAILURES[code])


def failure(error):
    code = error.code if isinstance(error, CheckError) else "execution_failed"
    return {"code": code, "message": FAILURES[code]}


def encoded(value):
    # Candidate and question order may be model inputs. Do not sort their keys.
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def read(path):
    try:
        with Path(path).open("rb") as source:
            raw = source.read(2 * 1024 * 1024 + 1)
    except FileNotFoundError:
        raise CheckError("missing_input") from None
    if len(raw) > 2 * 1024 * 1024:
        raise CheckError("input_too_large")
    try:
        value = json.loads(raw)
        encoded(value)  # Reject non-finite JSON extensions on every input path.
        return value
    except (ValueError, UnicodeError):
        raise CheckError("invalid_json") from None


def save(directory, name, value):
    (directory / name).write_bytes(encoded(value) + b"\n")


def client(endpoint, key_env):
    # No environment proxies, redirects or retries carrying keys elsewhere.
    import httpx2
    import typesafe_sdk as sdk
    import logging
    logging.getLogger("typesafe_sdk").disabled = True
    url = urlsplit(endpoint)
    if (url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password
            or url.query or url.fragment or (url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"})):
        raise CheckError("invalid_endpoint")
    key = os.environ.get(key_env, "")
    if not key or any(c.isspace() for c in key):
        raise CheckError("invalid_key")
    return sdk.TypeSafeClient(api_key=key, base_url=endpoint.rstrip("/"),
        retry=sdk.RetryPolicy(max_retries=0),
        http_client=httpx2.Client(timeout=180, trust_env=False, follow_redirects=False))


def probability(value):
    if type(value) not in {int, float} or not math.isfinite(value) or not 0 <= value <= 1:
        raise CheckError("invalid_answers")
    return value


def validate_answers(request, response):
    questions, answers = request["questions"], response["answers"]
    if not isinstance(answers, dict) or set(answers) != set(questions):
        raise CheckError("invalid_answers")
    for key, q in questions.items():
        answer = answers[key]
        if answer["type"] != q["type"]:
            raise CheckError("invalid_answers")
        if q["type"] == "noul":
            probability(answer["noul"])
            continue
        probability(answer["confidence"])
        expected = set(q["criteria"]) if q["type"] == "choice" else {str(i) for i in range(len(q["criteria"]))}
        distribution = answer["probabilities"]
        if set(distribution) != expected or not math.isclose(sum(probability(v) for v in distribution.values()), 1, abs_tol=1e-5):
            raise CheckError("invalid_answers")
        if q["type"] == "choice":
            if answer["choice"] not in expected:
                raise CheckError("invalid_answers")
            if distribution[answer["choice"]] != max(distribution.values()):
                raise CheckError("choice_not_maximum")
        else:
            if answer["legend"] != {str(i): v for i, v in enumerate(q["criteria"])}:
                raise CheckError("invalid_answers")
            expected_score = sum(int(i) * p for i, p in distribution.items())
            if type(answer["score"]) not in {int, float} or not math.isclose(answer["score"], expected_score, abs_tol=1e-5):
                raise CheckError("invalid_answers")
    for key in ("input_tokens", "output_tokens"):
        value = response["usage"][key]
        if type(value) is not int or not 0 <= value <= 2**63 - 1:
            raise CheckError("invalid_answers")


def evaluate(sdk_client, request, capture=None):
    # The official SDK serializes the request and decodes typed response objects.
    response = sdk_client.system_one(**request)
    if capture is not None:
        # Bodies only: never persist authorization or other HTTP headers.
        capture.with_name(capture.name + "-request-wire.json").write_bytes(response.raw_http_response.request.content)
        capture.with_name(capture.name + "-response-wire.json").write_bytes(response.raw_http_response.content)
    raw = json.loads(response.raw_http_response.content)
    if set(response.answers) != set(request["questions"]):
        raise CheckError("invalid_answers")
    validate_answers(request, raw)
    return raw


def same(left, right, tolerance):
    if type(left) is int and type(right) is int:
        return left == right
    if type(left) in {int, float} and type(right) in {int, float}:
        return math.isclose(left, right, rel_tol=0, abs_tol=tolerance)
    if type(left) != type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same(left[k], right[k], tolerance) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same(a, b, tolerance) for a, b in zip(left, right))
    return left == right


def review(args, output):
    state, questions = read(args.state), read(args.questions)
    request = {"model": args.model, "state": state, "questions": questions}
    save(output, "request.json", request)
    with client(args.endpoint, args.key_env) as reviewer:
        response = evaluate(reviewer, request, output / "review")
    save(output, "response.json", response)
    if response["model"] != args.expected_model:
        raise CheckError("unexpected_model")
    return {"kind": "review", "request_sha256": digest(request), "response_sha256": digest(response),
            "expected_model": args.expected_model, "passed": True}


def validate_probe_inputs(candidate, fixtures, tolerance):
    if (not isinstance(candidate.get("id"), str) or not candidate["id"]
            or not candidate.get("target") or any(not isinstance(candidate["target"].get(k), str)
                or not candidate["target"][k] for k in ("endpoint", "model", "response_model"))
            or not candidate.get("question_types")
            or not set(candidate["question_types"]) <= {"choice", "score", "noul"}):
        raise CheckError("invalid_candidate")
    if type(tolerance) not in {int, float} or not math.isfinite(tolerance) or not 0 <= tolerance <= 0.01:
        raise CheckError("invalid_tolerance")
    cases = fixtures["cases"]
    tested = {q["type"] for fixture in cases for q in fixture["questions"].values()}
    if (not cases or len(cases) > 32 or any(not fixture["questions"] for fixture in cases)
            or tested != set(candidate["question_types"])):
        raise CheckError("invalid_fixtures")
    return sorted(tested)


def validate_parity(target, direct, proxied, tolerance):
    if direct["model"] != target["response_model"] or proxied["model"] != target["response_model"]:
        raise CheckError("unexpected_model")
    if direct["usage"] != proxied["usage"] or not same(direct, proxied, tolerance):
        raise CheckError("parity_mismatch")


def probe(args, output):
    candidate, fixtures = read(args.candidate), read(args.fixtures)
    tested = validate_probe_inputs(candidate, fixtures, args.tolerance)
    target, model = candidate["target"], candidate["id"]
    save(output, "candidate.json", candidate)
    save(output, "fixtures.json", fixtures)
    records = []
    with client(args.endpoint, args.key_env) as gateway, client(target["endpoint"], args.native_key_env) as native:
        # Discovery lists the configured automatic route first, then backend IDs.
        if model not in {m.name for m in gateway.models.list().models[1:]}:
            raise CheckError("unexpected_model")
        for i, fixture in enumerate(fixtures["cases"]):
            original = {"model": target["model"], "state": fixture["state"], "questions": fixture["questions"]}
            routed = {**original, "model": model}
            save(output, f"case-{i}-native-request.json", original)
            save(output, f"case-{i}-gateway-request.json", routed)
            direct = evaluate(native, original, output / f"case-{i}-native")
            save(output, f"case-{i}-native-response.json", direct)
            proxied = evaluate(gateway, routed, output / f"case-{i}-gateway")
            save(output, f"case-{i}-gateway-response.json", proxied)
            validate_parity(target, direct, proxied, args.tolerance)
            records.append({"case": i, "native_sha256": digest(direct), "gateway_sha256": digest(proxied)})
    return {"kind": "probe", "passed": True, "candidate_sha256": digest(candidate),
            "fixtures_sha256": digest(fixtures), "model": model, "native_model": target["model"],
            "target_sha256": digest(target),
            "expected_model": target["response_model"], "tolerance": args.tolerance,
            "tested_question_types": tested, "cases": records}


def validate_wire(directory, prefix, request, response):
    wire_request = read(directory / f"{prefix}-request-wire.json")
    # SDK envelope order can differ; nested state/question/criterion order cannot.
    if (wire_request.keys() != request.keys()
            or any(digest(wire_request[k]) != digest(request[k]) for k in request)  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or digest(read(directory / f"{prefix}-response-wire.json")) != digest(response)):  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
        raise CheckError("wire_mismatch")
    validate_answers(request, response)


def validate_probe_bundle(candidate, directory):
    directory = Path(directory)
    report, fixtures = read(directory / "report.json"), read(directory / "fixtures.json")
    tested = validate_probe_inputs(candidate, fixtures, report["tolerance"])
    target = candidate["target"]
    if (report.get("kind") != "probe" or report.get("passed") is not True
            or report.get("candidate_sha256") != digest(candidate)  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or digest(read(directory / "candidate.json")) != digest(candidate)  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or report.get("target_sha256") != digest(target)  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or report.get("fixtures_sha256") != digest(fixtures)  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or report.get("model") != candidate["id"] or report.get("native_model") != target["model"]
            or report.get("expected_model") != target["response_model"]
            or report.get("tested_question_types") != tested
            or len(report["cases"]) != len(fixtures["cases"])):
        raise CheckError("probe_mismatch")
    for i, (fixture, record) in enumerate(zip(fixtures["cases"], report["cases"])):
        if type(record["case"]) is not int or record["case"] != i:
            raise CheckError("probe_mismatch")
        responses = []
        for route, model in (("native", target["model"]), ("gateway", candidate["id"])):
            prefix = f"case-{i}-{route}"
            request = read(directory / f"{prefix}-request.json")
            response = read(directory / f"{prefix}-response.json")
            expected = {"model": model, "state": fixture["state"], "questions": fixture["questions"]}
            if digest(request) != digest(expected) or digest(response) != record[f"{route}_sha256"]:  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
                raise CheckError("probe_mismatch")
            validate_wire(directory, prefix, request, response)
            responses.append(response)
        validate_parity(target, *responses, report["tolerance"])


def gate(candidate, review_directory, probe_directory=None):
    """Verify complete local bundles, then decide; never mutate a registry."""
    review_directory = Path(review_directory)
    request, response, review_report = (read(review_directory / name)
                                       for name in ("request.json", "response.json", "report.json"))
    if (digest(request["questions"]) != digest(read(RUBRIC))  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or digest(request["state"]) != digest({"candidate": candidate})  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or review_report.get("kind") != "review" or review_report.get("passed") is not True
            or review_report.get("request_sha256") != digest(request)  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or review_report.get("response_sha256") != digest(response)  # ubs:ignore[python.ctcompare.secret_eq] Local integrity hashes, not authentication.
            or review_report.get("expected_model") != response["model"]):
        raise CheckError("review_mismatch")
    validate_wire(review_directory, "review", request, response)
    findings = {key: answer["choice"] for key, answer in response["answers"].items()}
    if any(value in {"violation", "out_of_scope"} for value in findings.values()):
        return {"decision": "reject", "findings": findings}
    # This is an explicit conservative abstention heuristic, not calibrated confidence.
    uncertain = {key: response["answers"][key]["probabilities"][value] for key, value in findings.items()
                 if value == "insufficient_evidence" or response["answers"][key]["probabilities"][value] < 0.8}
    if uncertain:
        return {"decision": "hold", "findings": findings, "uncertain": uncertain}
    if probe_directory is None:
        return {"decision": "needs_endpoint_test", "findings": findings}
    validate_probe_bundle(candidate, probe_directory)
    return {"decision": "ready_for_opt_in", "findings": findings,
            "scope": "Reviewed proposal plus recorded fixture parity for this endpoint only; not calibration, checkpoint attestation, or production certification."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("review", "probe"):
        p = sub.add_parser(name)
        p.add_argument("--endpoint", required=True)
        p.add_argument("--key-env", default="ONE_SYSTEM_API_KEY")
        p.add_argument("--output", type=Path, required=True, help="new local evidence directory; never overwrite")
        if name == "review":
            p.add_argument("--model", required=True)
            p.add_argument("--expected-model", required=True)
            p.add_argument("--state", type=Path, required=True, help="explicitly selected content to send to reviewer")
            p.add_argument("--questions", type=Path, required=True)
        else:
            p.add_argument("--candidate", type=Path, required=True, help="derives alias and native endpoint/model/response identity")
            p.add_argument("--fixtures", type=Path, required=True)
            p.add_argument("--native-key-env", required=True)
            p.add_argument("--tolerance", type=float, default=1e-6)
    p = sub.add_parser("gate")
    p.add_argument("--candidate", type=Path, required=True)
    p.add_argument("--review", type=Path, required=True)
    p.add_argument("--probe", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "gate":
            result = gate(read(args.candidate), args.review, args.probe)
            print(encoded(result).decode())
            return 0 if result["decision"] == "ready_for_opt_in" else 1
        args.output.mkdir(parents=True, exist_ok=False)
        try:
            import typesafe_sdk
            result = (review if args.command == "review" else probe)(args, args.output)
            result.update(sdk_version=typesafe_sdk.__version__, recorded_at=datetime.now(timezone.utc).isoformat())
            save(args.output, "report.json", result)
        except Exception as error:
            save(args.output, "report.json", {"kind": args.command, "passed": False, "error": failure(error)})
            raise
        print(encoded(result).decode())
        return 0
    except Exception as error:
        # SDK/transport exceptions may contain endpoint paths or response text.
        print(encoded({"error": failure(error)}).decode(), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
