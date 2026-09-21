"""Check development prerequisites without installing packages or reading secrets."""

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def probe(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, cwd=ROOT, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=('go', 'hono', 'examples', 'all'), default='all')
    parser.add_argument('--node', default='node')
    parser.add_argument('--go', default='go')
    parser.add_argument('--bun', default='bun')
    parser.add_argument('--uv', default='uv')
    parser.add_argument('--example-venv', default='.build/example-venv')
    args = parser.parse_args()
    failures = []

    def check(label, ok, remedy):
        print(f'{"OK" if ok else "MISSING"}: {label}')
        if not ok:
            print(f'  {remedy}')
            failures.append(label)

    if args.profile in ('go', 'all'):
        version = probe([args.go, 'version']) or ''
        match = re.search(r'go(\d+)\.(\d+)', version)
        check('Go 1.23 or newer', bool(match and tuple(map(int, match.groups())) >= (1, 23)),
              'Install the pinned Go toolchain with mise install, or set GO to its executable.')

    if args.profile in ('hono', 'all'):
        raw = probe([args.node, '-p', 'JSON.stringify({node:process.versions.node,bun:process.versions.bun})'])
        try:
            versions = json.loads(raw or '{}')
            real_node = isinstance(versions, dict) and str(versions.get('node', '')).split('.')[0] == '24' and not versions.get('bun')
        except (ValueError, AttributeError):
            real_node = False
        check('Actual Node 24 (not the Bun compatibility executable)', real_node,
              'Run mise install and make doctor, or pass --node /path/to/node to this script.')
        check('Bun package runner', probe([args.bun, '--version']) is not None,
              'Install the pinned Bun with mise install, or set BUN to its executable.')
        missing = []
        try:
            lock = json.loads((ROOT / 'hono/package-lock.json').read_text())
            direct = lock['packages']['']
            for name in sorted(set(direct['dependencies']) | set(direct['devDependencies'])):
                installed = ROOT / 'hono/node_modules' / name / 'package.json'
                actual = json.loads(installed.read_text())['version']
                expected = lock['packages']['node_modules/' + name]['version']
                if actual != expected:
                    missing.append(name)
        except (OSError, ValueError, KeyError, TypeError):
            missing.append('missing or malformed dependency metadata')
        check('Hono direct dependencies match the committed lock', not missing,
              'Check package-lock.json, then run make setup-hono. This check does not certify every transitive dependency.')

    if args.profile in ('examples', 'all'):
        check('uv environment manager', probe([args.uv, '--version']) is not None,
              'Install the pinned uv with mise install, or set UV to its executable.')
        python = ROOT / args.example_venv / 'bin/python'
        raw = probe([str(python), '-c',
                     ('import json,sys,typesafe_sdk,yaml; from importlib.metadata import version; '
                     'print(json.dumps({"sdk":version("typesafe-sdk"),"yaml":version("PyYAML"),'
                     '"python":list(sys.version_info[:2])}))')])
        try:
            versions = json.loads(raw or '{}')
            ready = versions.get('sdk') == '0.7.0' and versions.get('yaml') == '6.0.3' and versions.get('python') == [3, 12]
        except (ValueError, AttributeError):
            ready = False
        check('Isolated Python 3.12 environment with SDK 0.7.0 and PyYAML 6.0.3', ready,
              'Run make setup-examples, or select an existing EXAMPLE_VENV. Honor package-age restrictions.')

    if args.profile == 'all':
        check('Gitleaks secret scanner', shutil.which('gitleaks') is not None,
              'Install Gitleaks before committing; see CONTRIBUTING.md.')
        check('true-up 0.2.1 dependency checker', probe(['true-up', '--version']) == 'true-up 0.2.1',
              'Install true-up 0.2.1 for the declared dependency gate; see CONTRIBUTING.md.')
        # Hosted workflows are manual, so a dormant or outdated pre-push hook means nothing checks a push.
        common = probe(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
        installed = Path(common or '', 'hooks')
        current = bool(common) and probe(['git', 'config', '--get', 'core.hooksPath']) == str(installed) and all(
            (installed / name).is_file() and (installed / name).read_bytes() == (ROOT / '.githooks' / name).read_bytes()
            for name in ('pre-commit', 'pre-push'))
        check('Repository Git hooks installed and current (secret scan and push gate)', current,
              'Run make setup-hooks; no other hook path runs .githooks/pre-commit and .githooks/pre-push.')
        if (ROOT / '.jj').exists():
            print('WARNING: jj git push runs no Git hooks; run make check-commit before pushing with jj.')
    print('No inference or credential checks were performed; no install commands were run.')
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
