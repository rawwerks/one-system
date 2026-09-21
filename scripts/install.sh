#!/bin/sh
# Keep every action inside main: a truncated curl | sh must not start an install.
main() (
    set -efu
    LC_ALL=C
    export LC_ALL
    unset TAR_OPTIONS GZIP
    umask 077

    work=
    launcher_stage=
    owned_prefix=
    owned_launcher=
    committed=0

    cleanup() {
        status=$?
        trap - 0 HUP INT TERM
        if [ "$committed" -eq 0 ]; then
            [ -z "$owned_launcher" ] || rm -f "$owned_launcher" || :
            [ -z "$owned_prefix" ] || rm -rf "$owned_prefix" || :
        fi
        [ -z "$launcher_stage" ] || rm -f "$launcher_stage" || :
        [ -z "$work" ] || rm -rf "$work" || :
        exit "$status"
    }
    trap cleanup 0
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    die() {
        printf 'one-system installer: %s\n' "$*" >&2
        exit 1
    }

    usage() {
        cat <<'USAGE'
Usage: install.sh [--version TAG] [--prefix DIR] [--bin-dir DIR] [--from DIR]

Install the complete One System Go bundle for Linux or macOS, amd64 or arm64.
macOS requires version 13 or newer. No Go, Node, or Python is required.

  --version TAG  GitHub release tag (default: latest)
  --prefix DIR   Bundle location (default: $HOME/.local/share/one-system)
  --bin-dir DIR  Launcher directory (default: $HOME/.local/bin)
  --from DIR     Read the platform archive and SHA256SUMS locally; no network
  --help         Show this help

Downloads use authenticated gh when available, otherwise HTTPS-only curl.
The repository is rawwerks/one-system; private releases require gh authentication.
Existing bundle or launcher paths are never replaced, including dangling links.
This installer does not upgrade, use sudo, start services, edit shell profiles,
or configure credentials. Parent directories must be writable and trusted.

The launcher changes to the installed bundle directory before running the gateway.
Relative ONE_SYSTEM_CONFIG and question paths resolve there. Use absolute paths
for custom configurations and question files. The gateway does not load .env.
USAGE
    }

    require_value() {
        [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 requires a nonempty value"
    }

    exists() {
        [ -e "$1" ] || [ -L "$1" ]
    }

    absolute_path() (
        # Resolve existing directory components without creating anything. Resolve
        # symlinks before "..", and retain missing suffixes for later mkdir calls.
        # This makes overlap checks physical even when final parents do not exist.
        case "$1" in
            /*) resolved=/; remaining=${1#/} ;;
            *) resolved=$start_directory; remaining=$1 ;;
        esac
        while [ -n "$remaining" ]; do
            component=${remaining%%/*}
            if [ "$remaining" = "$component" ]; then
                remaining=
            else
                remaining=${remaining#*/}
            fi
            case "$component" in
                ''|.) continue ;;
                ..) resolved=${resolved%/*}; resolved=${resolved:-/} ;;
                *)
                    candidate=${resolved%/}/$component
                    if [ -d "$candidate" ]; then
                        resolved=$(CDPATH= cd -P "$candidate" && pwd -P) ||
                            die "could not resolve directory: $candidate"
                    else
                        if exists "$candidate" && [ -n "$remaining" ]; then
                            die "not a directory: $candidate"
                        fi
                        resolved=$candidate
                    fi
                    ;;
            esac
        done
        printf '%s\n' "$resolved"
    )

    quote_shell() {
        quote_rest=$1
        printf "'"
        while :; do
            case "$quote_rest" in
                *"'"*)
                    printf '%s' "${quote_rest%%"'"*}" "'\\''"
                    quote_rest=${quote_rest#*"'"}
                    ;;
                *) printf "%s'" "$quote_rest"; break ;;
            esac
        done
    }

    check_destinations() {
        exists "$prefix" && die "bundle destination already exists: $prefix"
        exists "$launcher" && die "launcher destination already exists: $launcher"
        case "$bin_dir/" in
            "$prefix/"*) die '--bin-dir must not be inside --prefix' ;;
        esac
        case "$prefix/" in
            "$launcher/"*) die '--prefix must not be inside the launcher path' ;;
        esac
        return 0
    }

    fetch_assets() {
        if [ -n "$source_dir" ]; then
            [ -f "$source_dir/$archive" ] || die "missing local archive: $source_dir/$archive"
            [ -f "$source_dir/SHA256SUMS" ] || die "missing local manifest: $source_dir/SHA256SUMS"
            cp "$source_dir/$archive" "$work/$archive"
            cp "$source_dir/SHA256SUMS" "$work/SHA256SUMS"
        elif command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
            if [ "$version" = latest ]; then
                gh release download --repo "github.com/$repository" --pattern "$archive" --pattern SHA256SUMS --dir "$work" ||
                    die 'GitHub download failed; check release availability and gh repository access'
            else
                gh release download "$version" --repo "github.com/$repository" --pattern "$archive" --pattern SHA256SUMS --dir "$work" ||
                    die 'GitHub download failed; check the release tag and gh repository access'
            fi
        else
            command -v curl >/dev/null 2>&1 || die 'install curl or authenticate the GitHub CLI (gh) to download releases'
            if [ "$version" = latest ]; then
                release_url=https://github.com/$repository/releases/latest/download
            else
                release_url=https://github.com/$repository/releases/download/$version
            fi
            for asset in "$archive" SHA256SUMS; do
                curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
                    --output "$work/$asset" "$release_url/$asset" ||
                    die 'HTTPS download failed; private releases require authenticated gh, or use --from DIR'
            done
        fi
    }

    verify_checksum() {
        expected=$(awk -v name="$archive" '
            {
                selected = 0
                for (i = 1; i <= NF; i++)
                    if ($i == name || $i == "*" name) selected = 1
                if (!selected) next
                matches++
                digest = substr($0, 1, 64)
                separator = substr($0, 65, 2)
                if (length(digest) != 64 || digest ~ /[^0-9a-fA-F]/ ||
                    (separator != "  " && separator != " *") || substr($0, 67) != name)
                    invalid = 1
                value = tolower(digest)
            }
            END {
                if (matches != 1 || invalid) exit 1
                print value
            }
        ' "$work/SHA256SUMS") || die "SHA256SUMS needs exactly one well-formed entry for $archive"
        if command -v sha256sum >/dev/null 2>&1; then
            actual=$(sha256sum < "$work/$archive") || die 'could not calculate SHA256'
        else
            actual=$(shasum -a 256 < "$work/$archive") || die 'could not calculate SHA256'
        fi
        actual=${actual%% *}
        [ "$actual" = "$expected" ] || die "SHA256 mismatch for $archive"
    }

    inspect_archive() {
        # Releases use plain USTAR. Read raw headers rather than trusting tar -t:
        # tar listings hide PAX/GNU extension entries and may escape member names.
        # Only headers and final zero padding are inspected; file payloads are skipped.
        gzip -dc "$work/$archive" > "$work/bundle.tar" || die 'invalid gzip archive'
        tar_size=$(wc -c < "$work/bundle.tar")
        tar_size=$((tar_size + 0))
        [ "$((tar_size % 512))" -eq 0 ] || die 'truncated tar archive'
        offset=0
        members=0
        files=0
        directories=0
        seen='|'
        while :; do
            [ "$offset" -lt "$tar_size" ] || die 'tar archive has no end marker'
            od -An -v -tu1 -j "$offset" -N 512 "$work/bundle.tar" > "$work/header.bytes" ||
                die 'could not read tar header'
            header=$(awk '
                function octal(start, width,   i, c, value) {
                    value = 0
                    for (i = start; i < start + width; i++) {
                        c = byte[i]
                        if (c < 48 || c > 55) return -1
                        value = value * 8 + c - 48
                    }
                    return value
                }
                { for (i = 1; i <= NF; i++) byte[++count] = $i }
                END {
                    if (count != 512) exit 1
                    total = 0
                    for (i = 1; i <= 512; i++) total += byte[i]
                    if (!total) { print "end"; exit }
                    if (byte[136] != 0 || byte[155] != 0 || byte[156] != 32) exit 1
                    checksum = octal(149, 6)
                    for (i = 149; i <= 156; i++) total += 32 - byte[i]
                    if (checksum != total) exit 1
                    if (byte[258] != 117 || byte[259] != 115 || byte[260] != 116 ||
                        byte[261] != 97 || byte[262] != 114 || byte[263] != 0 ||
                        byte[264] != 48 || byte[265] != 48) exit 1
                    # No link target, prefix, or extension fields are needed by this inventory.
                    for (i = 158; i <= 257; i++) if (byte[i]) exit 1
                    for (i = 346; i <= 512; i++) if (byte[i]) exit 1
                    name = ""; ended = 0
                    for (i = 1; i <= 100; i++) {
                        if (!byte[i]) { ended = 1; continue }
                        if (ended || byte[i] < 33 || byte[i] > 126) exit 1
                        name = name sprintf("%c", byte[i])
                    }
                    if (name == "" || name ~ /[^A-Za-z0-9._\/-]/) exit 1
                    size = octal(125, 11)
                    if (size < 0) exit 1
                    if (byte[157] == 53 && size == 0) type = "d"
                    else if (byte[157] == 48 || byte[157] == 0) type = "f"
                    else exit 1
                    printf "%s %.0f %s\n", type, size, name
                }
            ' "$work/header.bytes") || die 'unsafe, malformed, or non-USTAR archive header'
            if [ "$header" = end ]; then
                [ "$((tar_size - offset))" -ge 1024 ] || die 'tar archive has an incomplete end marker'
                od -An -v -tu1 -j "$offset" "$work/bundle.tar" > "$work/trailer.bytes" ||
                    die 'could not read tar end marker'
                awk '{ for (i = 1; i <= NF; i++) if ($i != 0) exit 1 }' "$work/trailer.bytes" ||
                    die 'tar archive has data after its end marker'
                break
            fi
            # The header decoder emits exactly three whitespace-free, validated fields.
            set -- $header
            entry_type=$1
            entry_size=$2
            entry_name=$3
            case "$seen" in
                *"|$entry_name|"*) die "duplicate archive member: $entry_name" ;;
            esac
            seen=$seen$entry_name'|'
            case "$entry_name" in
                "$bundle/"|"$bundle/examples/")
                    [ "$entry_type" = d ] || die "expected directory: $entry_name"
                    directories=$((directories + 1))
                    ;;
                "$bundle/one-system"|"$bundle/INSTALL.md"|"$bundle/THIRD_PARTY_NOTICES.txt"|\
                "$bundle/build-info.json"|"$bundle/backends.json"|\
                "$bundle/examples/local.backends.json"|"$bundle/examples/privacy.backends.json"|\
                "$bundle/examples/jev-lint.backends.json"|"$bundle/examples/simple-jev.backends.json"|\
                "$bundle/examples/routing.questions.json"|"$bundle/examples/english.json"|\
                "$bundle/examples/multilingual.json")
                    [ "$entry_type" = f ] || die "expected regular file: $entry_name"
                    files=$((files + 1))
                    ;;
                *) die "unexpected archive member: $entry_name" ;;
            esac
            members=$((members + 1))
            offset=$((offset + 512 + ((entry_size + 511) / 512) * 512))
            [ "$offset" -le "$tar_size" ] || die 'truncated archive member'
        done
        [ "$members" -eq 14 ] && [ "$files" -eq 12 ] && [ "$directories" -eq 2 ] ||
            die 'archive does not contain the complete bundle inventory'
    }

    version=latest
    prefix=${HOME:+$HOME/.local/share/one-system}
    bin_dir=${HOME:+$HOME/.local/bin}
    source_dir=
    repository=rawwerks/one-system
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --version) require_value "$@"; version=$2; shift 2 ;;
            --prefix) require_value "$@"; prefix=$2; shift 2 ;;
            --bin-dir) require_value "$@"; bin_dir=$2; shift 2 ;;
            --from) require_value "$@"; source_dir=$2; shift 2 ;;
            --help) usage; exit 0 ;;
            *) die "unknown argument: $1 (use --help)" ;;
        esac
    done
    case "$version" in
        ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._+-]*) die 'release tag must start with a letter or digit and contain only letters, digits, dot, underscore, plus, or hyphen' ;;
    esac
    [ -n "$prefix" ] && [ -n "$bin_dir" ] || die 'set HOME, or supply both --prefix and --bin-dir'
    carriage_return=$(printf '\r')
    for path in "$prefix" "$bin_dir" "$source_dir"; do
        case "$path" in
            *'
'*|*"$carriage_return"*) die 'directory paths must not contain newline or carriage return characters' ;;
        esac
    done
    for utility in awk cat chmod cp dirname basename gzip link mkdir mktemp od pwd rm tar uname wc; do
        command -v "$utility" >/dev/null 2>&1 || die "required utility is unavailable: $utility"
    done
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
        die 'SHA256 verification requires sha256sum or shasum'
    os=$(uname -s) || die 'could not detect operating system'
    case "$os" in
        Linux) platform=linux ;;
        Darwin)
            platform=darwin
            command -v sw_vers >/dev/null 2>&1 || die 'could not determine macOS version'
            macos_version=$(sw_vers -productVersion) || die 'could not determine macOS version'
            macos_major=${macos_version%%.*}
            case "$macos_major" in ''|*[!0-9]*) die 'could not determine macOS major version' ;; esac
            [ "$macos_major" -ge 13 ] || die 'macOS 13 or newer is required'
            ;;
        *) die "unsupported operating system: $os" ;;
    esac
    machine=$(uname -m) || die 'could not detect machine architecture'
    case "$machine" in
        x86_64|amd64) architecture=amd64 ;;
        aarch64|arm64) architecture=arm64 ;;
        *) die "unsupported architecture: $machine" ;;
    esac
    bundle=one-system-$platform-$architecture
    archive=$bundle.tar.gz
    start_directory=$(pwd -P) || die 'could not determine working directory'
    prefix=$(absolute_path "$prefix")
    bin_dir=$(absolute_path "$bin_dir")
    launcher=$bin_dir/one-system
    [ -z "$source_dir" ] || source_dir=$(absolute_path "$source_dir")
    check_destinations

    temp_root=${TMPDIR:-/tmp}
    temp_root=$(absolute_path "$temp_root")
    work=$(mktemp -d "$temp_root/one-system-install.XXXXXXXXXX") || die 'could not create private staging directory'
    fetch_assets
    verify_checksum
    inspect_archive
    mkdir "$work/extracted"
    COPYFILE_DISABLE=1 tar --no-same-owner --no-same-permissions -xf "$work/bundle.tar" -C "$work/extracted" ||
        die 'could not extract the verified bundle'
    staged=$work/extracted/$bundle
    chmod 755 "$staged" "$staged/examples" "$staged/one-system"
    data_files='INSTALL.md THIRD_PARTY_NOTICES.txt build-info.json backends.json
        examples/local.backends.json examples/privacy.backends.json examples/jev-lint.backends.json
        examples/simple-jev.backends.json examples/routing.questions.json examples/english.json examples/multilingual.json'
    for file in $data_files; do
        chmod 644 "$staged/$file"
    done

    # Everything above finishes before creating either final target. Parent
    # directories may be shared; they are never removed by rollback or cleanup.
    prefix_parent=$(dirname "$prefix")
    prefix_name=$(basename "$prefix")
    mkdir -p "$prefix_parent" "$bin_dir" || die 'could not create installation parent directories'
    prefix_parent=$(CDPATH= cd -P "$prefix_parent" && pwd -P)
    bin_dir=$(CDPATH= cd -P "$bin_dir" && pwd -P)
    prefix=$prefix_parent/$prefix_name
    launcher=$bin_dir/one-system
    check_destinations
    launcher_stage=$(mktemp "$bin_dir/.one-system-launcher.XXXXXXXXXX") || die 'could not stage the launcher'
    {
        printf '#!/bin/sh\ncd '
        quote_shell "$prefix"
        printf ' || exit 1\nexec ./one-system "$@"\n'
    } > "$launcher_stage"
    chmod 755 "$launcher_stage"

    # mkdir and link are exclusive creations: neither replaces a raced-in path.
    # Unlike ln, POSIX link never treats an existing directory as a destination.
    mkdir "$prefix" || die "bundle destination could not be created: $prefix"
    owned_prefix=$prefix
    cp -R "$staged/." "$prefix/" || die 'could not install bundle files'
    # cp creates files under this script's private umask; restore the staged modes.
    chmod 755 "$prefix" "$prefix/examples" "$prefix/one-system"
    for file in $data_files; do
        chmod 644 "$prefix/$file"
    done
    link "$launcher_stage" "$launcher" || die "launcher destination could not be created: $launcher"
    owned_launcher=$launcher
    committed=1

    printf 'Installed bundle: %s\nLauncher: %s\n' "$prefix" "$launcher"
    printf '%s\n' 'The launcher runs from the installed bundle directory.' \
        'Relative ONE_SYSTEM_CONFIG and question paths resolve there; use absolute paths for custom files.' \
        'No service was started, credentials configured, or shell profile changed. The gateway does not load .env.'
    printf 'To add the launcher directory to PATH in this shell:\n  export PATH='
    quote_shell "$bin_dir"
    printf ':"$PATH"\nOr invoke the launcher directly: '
    quote_shell "$launcher"
    printf '\n'
)
main "$@"
