# /// script
# requires-python = ">=3.10"
# dependencies = ["typesafe-sdk==0.7.0"]
# ///
"""Laya + Jev in parallel, then Jev adjudication; one standard response on stdout.

Use a running gateway with explicit Laya and Jev backend IDs, for example the
local/hosted entries in backends.json or examples/privacy.backends.json:

    TYPESAFE_ENDPOINT=http://127.0.0.1:8090 TYPESAFE_API_KEY=your-gateway-key \
        .build/example-venv/bin/python examples/laya_jev_ensemble.py \
        --laya-model local --jev-model hosted --output .build/ensemble-demo

The versioned fixture contains public synthetic input only. A successful run makes
three requests, including two hosted Jev requests that may incur charges. This is
client-side orchestration, not a new gateway route or a claim of improved quality.
An optional fresh output directory retains request/response bodies and a report,
never headers or credentials. Any failed or invalid stage prevents a final answer;
there are no retries, redirects, fallback, or partial-success results.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

from public_release_review import make_client
from system_one_check import validate_answers

FIXTURE = Path(__file__).with_name("laya-jev-ensemble.json")


def save(directory, name, value):
    if directory is not None:
        with os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write("\n")


async def run_ensemble(laya_model, jev_model, output=None):
    import typesafe_sdk as sdk

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    questions = fixture["questions"]
    stages = []
    started = time.monotonic()
    final = None
    # Reuse the existing consumer's explicit origin/key and no-proxy/no-redirect
    # configuration. Override its review retry policy on EVERY ensemble call.
    async with make_client() as client:
        async def ask(stage, model, state, stage_questions):
            request = {"model": model, "state": state, "questions": stage_questions}
            observation = {"stage": stage, "requested_model": model,
                           "started_ms": round((time.monotonic() - started) * 1000, 3)}
            stages.append(observation)
            try:
                save(output, stage + ".request.json", request)
                response = await client.system_one(**request, retry=sdk.RetryPolicy(max_retries=0))
                raw = json.loads(response.raw_http_response.content)
                save(output, stage + ".response.json", raw)
                validate_answers(request, raw)
                observation.update(status="completed", returned_model=raw["model"], usage=raw["usage"])
                return raw
            except Exception:
                observation["status"] = "failed"
                raise
            finally:
                observation["finished_ms"] = round((time.monotonic() - started) * 1000, 3)

        try:
            # Settle both independent calls before closing the shared HTTP client.
            # If either fails, never send an incomplete panel to the adjudicator.
            panel = await asyncio.gather(
                ask("laya", laya_model, fixture["state"], questions),
                ask("jev", jev_model, fixture["state"], questions),
                return_exceptions=True,
            )
            if any(isinstance(result, BaseException) for result in panel):
                raise RuntimeError("initial_stage_failed")
            laya, jev = panel
            state = {
                "original_state": fixture["state"],
                "expert_judgments": {
                    name: {"model": result["model"], "answers": result["answers"]}
                    for name, result in (("laya", laya), ("jev", jev))
                },
            }
            adjudication_questions = {
                name: {**question, "instructions": {
                    "original_question": question["instructions"],
                    "task": fixture["adjudication_instructions"],
                }}
                for name, question in questions.items()
            }
            adjudication = await ask("adjudication", jev_model, state, adjudication_questions)
            result = {
                "model": fixture["model"],
                "answers": adjudication["answers"],
                "usage": {key: sum(result["usage"][key] for result in (laya, jev, adjudication))
                          for key in ("input_tokens", "output_tokens")},
            }
            validate_answers({"questions": questions}, result)
            save(output, "final.response.json", result)
            final = result
            return final
        finally:
            save(output, "report.json", {
                "status": "completed" if final is not None else "incomplete",
                "purpose": "Feasibility example, not a quality comparison",
                "stages": stages,
            })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--laya-model", required=True, help="Explicit gateway backend ID for Laya, e.g. local")
    parser.add_argument("--jev-model", required=True, help="Explicit gateway backend ID for Jev, e.g. hosted")
    parser.add_argument("--output", type=Path, help="Optional new directory for stage bodies and report")
    args = parser.parse_args()
    try:
        if (not args.laya_model.strip() or not args.jev_model.strip()
                or args.laya_model == args.jev_model):
            raise ValueError("distinct_backend_ids_required")
        if args.output is not None:
            args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
        result = asyncio.run(run_ensemble(args.laya_model, args.jev_model, args.output))
        print(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2))
        return 0
    except Exception:
        print("Ensemble incomplete: check gateway configuration, backend availability and any stage report. No final answer returned.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
