# Source this to load .env into the current shell's environment:
#   . scripts/load-env.sh
# Mirrors load-env.ps1: plain KEY=VALUE lines, no shell evaluation, # comments
# and blank lines skipped.
_aijudge_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
if [ ! -f "$_aijudge_root/.env" ]; then
    echo "WARNING: .env not found at $_aijudge_root/.env - copy .env.example to .env and fill in AZURE_API_KEY first." >&2
else
    while IFS= read -r _line || [ -n "$_line" ]; do
        _line="${_line%$'\r'}"
        case "$_line" in ''|'#'*|[[:space:]]*'#'*) continue ;; esac
        case "$_line" in *=*) ;; *) continue ;; esac
        _key="${_line%%=*}"; _val="${_line#*=}"
        _key="$(printf '%s' "$_key" | tr -d '[:space:]')"
        _val="$(printf '%s' "$_val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        [ -n "$_key" ] && export "$_key=$_val"
    done < "$_aijudge_root/.env"
fi
unset _line _key _val
