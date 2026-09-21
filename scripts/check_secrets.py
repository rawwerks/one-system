"""Scan shareable working files and Git history without opening ignored secrets."""

import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def git_output(repository, *args):
    return subprocess.check_output(
        ['git', *args], cwd=repository, stderr=subprocess.PIPE, timeout=30,
    ).decode(errors='surrogateescape')


def safe_path(root, source):
    if not source.is_relative_to(root):
        print('Review symlink or out-of-root path before sharing.')
        return False
    current = root
    for part in source.relative_to(root).parts:
        current /= part
        if part == '..' or current.is_symlink():
            print(f'Review symlink before sharing: {source.relative_to(root)}')
            return False
    return True


def valid_submodule(root, source, commit):
    name = source.relative_to(root)
    if not source.is_dir():
        print(f'Review submodule before sharing (missing or non-directory): {name}')
        return False
    if not safe_path(root, source / '.git'):
        return False
    try:
        toplevel = Path(git_output(source, 'rev-parse', '--show-toplevel').rstrip('\n'))
        if toplevel.resolve() != source:
            print(f'Review submodule before sharing (not initialized at its own root): {name}')
            return False
        if git_output(source, 'cat-file', '-t', commit).strip() != 'commit':
            print(f'Review submodule before sharing (indexed object is not a commit): {name}')
            return False
        if git_output(source, 'rev-parse', '--verify', 'HEAD').strip() != commit:
            print(f'Review submodule before sharing (HEAD differs from indexed commit): {name}')
            return False
    except (OSError, subprocess.SubprocessError):
        print(f'Review submodule before sharing (repository or indexed commit unavailable): {name}')
        return False
    return True


def collect_sources(root, repository, repositories, sources):
    # Read gitlink identity from the index, not from a directory's presence or
    # .gitmodules alone. A missing gitlink must never look like a deleted file.
    gitlinks = {}
    for entry in git_output(repository, 'ls-files', '--stage', '-z').split('\0'):
        if not entry:
            continue
        metadata, name = entry.split('\t', 1)
        mode, commit, stage = metadata.split()
        if mode == '160000':
            if stage != '0':
                print(f'Review submodule before sharing (unmerged index): {(repository / name).relative_to(root)}')
                return False
            gitlinks[name] = commit
    files = git_output(
        repository, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ).split('\0')
    repositories.append(repository)
    for name in sorted((set(files) | gitlinks.keys()) - {''}):
        source = repository / name
        if not safe_path(root, source):
            return False
        if name in gitlinks:
            if not valid_submodule(root, source, gitlinks[name]):
                return False
            if not collect_sources(root, source, repositories, sources):
                return False
        elif not source.exists():
            continue  # Deleted tracked file; history is scanned separately.
        elif not source.is_file():
            print(f'Review non-file tracked entry before sharing: {source.relative_to(root)}')
            return False
        else:
            sources.append(source)
    return True


def main():
    scanner = shutil.which('gitleaks')
    if scanner is None:
        print('Gitleaks is required. Install it before running make check-secrets.')
        return 1
    # macOS may expose the root through /var -> /private/var. Compare canonical
    # roots while still rejecting every symlink beneath the repository root.
    root = ROOT.resolve()
    repositories = []
    sources = []
    # Complete preflight across every repository before opening any source for
    # copying, including files that sort before an unsafe path or submodule.
    if not collect_sources(root, root, repositories, sources):
        return 1
    scratch = Path.home() / 'scratch/one-system-secret-check'
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='source-', dir=scratch) as directory:
        snapshot = Path(directory)
        for source in sources:
            target = snapshot / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        print('Scanning tracked and nonignored working files (secret values redacted).', flush=True)
        current = subprocess.run([scanner, 'dir', '--redact=100', '--no-banner', str(snapshot)], cwd=root, check=False, timeout=300)
        if current.returncode:
            return current.returncode
    for repository in repositories:
        print(f'Scanning staged changes in {repository.relative_to(root)} (secret values redacted).', flush=True)
        staged = subprocess.run([scanner, 'git', '--pre-commit', '--staged', '--redact=100', '--no-banner'], cwd=repository, check=False, timeout=300)
        if staged.returncode:
            return staged.returncode
        print(f'Scanning all Git refs, including notes, in {repository.relative_to(root)} (secret values redacted).', flush=True)
        history = subprocess.run([scanner, 'git', '--log-opts=--all', '--redact=100', '--no-banner'], cwd=repository, check=False, timeout=300)
        if history.returncode:
            return history.returncode
    print('Secret scan passed. Private prompts, responses, and identities still require content review.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, subprocess.SubprocessError):
        print('Secret scan incomplete: check Git/Gitleaks availability and retry; no clean result was established.')
        raise SystemExit(1) from None
