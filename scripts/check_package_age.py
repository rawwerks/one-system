"""Require every registry artifact in uv.lock to be at least 72 hours old.

This conservative check includes every platform and optional extra. It validates
the committed upload-time metadata before uv can reuse the lock without resolving.
Requires Python 3.11 or newer; the virtual project itself is exempt.
"""

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tomllib

COOLDOWN = timedelta(hours=72)


def validate_package_age(lock, now):
    """Return policy failures, using an explicit aware clock for deterministic tests."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("The package-age clock must include a timezone")
    packages = lock.get("package")
    if not isinstance(packages, list) or not packages:
        return ["Lock must contain a nonempty package list"]
    errors = []
    for package in packages:
        if not isinstance(package, dict):
            errors.append("Invalid package entry")
            continue
        label = f'{package.get("name", "<unnamed>")}=={package.get("version", "<unversioned>")}'
        source = package.get("source", {})
        if source == {"virtual": "."}:
            continue
        if not isinstance(source, dict) or set(source) != {"registry"}:
            errors.append(f"{label}: unsupported source; upload age cannot be verified")
            continue
        wheels = package.get("wheels", [])
        if not isinstance(wheels, list):
            errors.append(f"{label}: invalid wheel list")
            continue
        artifacts = list(wheels)
        if "sdist" in package:
            artifacts.append(package["sdist"])
        if not artifacts:
            errors.append(f"{label}: no registry artifacts with upload times")
        for index, artifact in enumerate(artifacts):
            try:
                timestamp = artifact["upload-time"]
                uploaded = datetime.fromisoformat(timestamp)
                if uploaded.tzinfo is None or uploaded.utcoffset() is None:
                    raise ValueError("Missing timezone")
                eligible = uploaded.astimezone(timezone.utc) + COOLDOWN
            except (KeyError, TypeError, ValueError, OverflowError):
                errors.append(f"{label} artifact {index + 1}: missing or invalid timezone-aware upload-time")
                continue
            if eligible > now:
                errors.append(f"{label} artifact {index + 1}: 72-hour cooldown ends {eligible.isoformat()}")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lock", nargs="?", type=Path, default=Path("uv.lock"))
    args = parser.parse_args()
    try:
        with args.lock.open("rb") as stream:
            lock = tomllib.load(stream)
        errors = validate_package_age(lock, datetime.now(timezone.utc))
    except (OSError, ValueError) as error:
        errors = [str(error)]
    if errors:
        print("Package age check failed; no install was started:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print("Package age check passed: all locked registry artifacts satisfy the 72-hour cooldown.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
