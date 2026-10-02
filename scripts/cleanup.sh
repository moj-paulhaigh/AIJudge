#!/usr/bin/env bash
set -euo pipefail

usage() {
    printf '%s\n' \
        'Usage: scripts/cleanup.sh [--apply] [--yes]' \
        '' \
        'Permanently deletes all session state, blocklist, statistics, logs and verdicts.' \
        'Default: preview only. Stop all three services before using --apply.' \
        '--yes skips the confirmation prompt (requires --apply).' \
        'AIJUDGE_DATA_DIR overrides the default repo-root data directory.'
}

apply=false
confirm=true
for argument in "$@"; do
    case "$argument" in
        --apply) apply=true ;;
        --yes) confirm=false ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'Unknown argument: %s\n' "$argument" >&2; usage >&2; exit 1 ;;
    esac
done

root="$(cd "$(dirname "$0")/.." && pwd)"
data_dir_override="${AIJUDGE_DATA_DIR-}"
if [[ -f "$root/.env" ]]; then
    . "$root/scripts/load-env.sh"
fi
data_dir="${data_dir_override:-${AIJUDGE_DATA_DIR:-data}}"
if [[ "$data_dir" != /* ]]; then
    data_dir="$root/$data_dir"
fi
if [[ -L "${data_dir%/}" ]]; then
    printf 'Refusing to delete a symlink: %s\n' "$data_dir" >&2
    exit 1
fi
data_dir="$(realpath -m -- "$data_dir")"
if [[ "$data_dir" == / || "$root" == "$data_dir" || "$root" == "$data_dir/"* ]]; then
    printf 'Refusing unsafe data directory: %s\n' "$data_dir" >&2
    exit 1
fi
if [[ ! -e "$data_dir" ]]; then
    printf 'Nothing to clean: %s does not exist.\n' "$data_dir"
    exit 0
fi
if [[ ! -d "$data_dir" || ( ! -f "$data_dir/aijudge.db" && ! -d "$data_dir/logs" && ! -d "$data_dir/verdicts" ) ]]; then
    printf 'Refusing directory without recognized AIJudge data: %s\n' "$data_dir" >&2
    exit 1
fi

printf 'Data directory to permanently delete: %s\n' "$data_dir"
if [[ "$apply" == false ]]; then
    printf 'Preview only. Run with --apply to delete this directory. No backup is created.\n'
    exit 0
fi

running="$(ps -eo comm=,args= | awk '
    $1 ~ /^(python[0-9.]*|litellm|uvicorn)$/ &&
    ($0 ~ /litellm.*--config/ || $0 ~ /uvicorn.*(chatui\.backend\.app|judge_ui\.app)/) { print }
')"
if [[ -n "$running" ]]; then
    printf 'Stop the LiteLLM proxy, chat backend and Judge Dashboard first:\n%s\n' "$running" >&2
    exit 1
fi
if [[ "$confirm" == true ]]; then
    printf 'Permanently delete sessions, statistics, blocks and logs? Type DELETE to proceed: '
    read -r answer
    if [[ "$answer" != DELETE ]]; then
        printf 'Cancelled.\n'
        exit 1
    fi
fi

rm -r -- "$data_dir"
printf 'Deleted %s\nRestart the services to create fresh storage, then refresh the chat page.\n' "$data_dir"