#!/usr/bin/env bash
# Prints one status line row per subagent, from the file the agent-watch mod
# writes for a session every 5 seconds. Prints nothing while no agent runs.
#
#   bash agent-rows.sh               # as the whole status line command: reads
#                                    # the status line JSON on stdin
#   bash agent-rows.sh SESSION_ID    # from your own status line script
#
# Needs jq. Runs on bash 3.2 (macOS) and later.

sid=$1
[[ -n "$sid" ]] || sid=$(jq -r '.session_id // ""' 2>/dev/null)
f="/tmp/claude-${UID}/agent-watch/${sid}.json"
[[ -n "$sid" && -r "$f" ]] || exit 0

MAX_ROWS=5
esc=$'\e'
reset="${esc}[0m"
c() { printf '%s[38;5;%sm' "$esc" "$1"; }

# Horizontal bar with 1/8-cell resolution on a dark background.
graph() {  # graph PERCENT COLOR WIDTH
  local p=${1%.*} col=$2 w=$3 i
  ((p > 100)) && p=100
  local eighths=$(((p * w * 8 + 50) / 100))
  local full=$((eighths / 8)) part=$((eighths % 8))
  local parts=(" " "▏" "▎" "▍" "▌" "▋" "▊" "▉")
  local s="${esc}[48;5;236m$(c "$col")"
  for ((i = 0; i < full; i++)); do s+="█"; done
  if ((full < w)); then
    s+="${parts[part]}"
    for ((i = full + 1; i < w; i++)); do s+=" "; done
  fi
  printf '%s%s' "$s" "$reset"
}

# A file older than 30 s belongs to a session that stopped.
now=$(date +%s)
rows=$(jq -r --argjson now "$now" '
  def clip($n): gsub("\\s+"; " ") | if length > $n then .[0:$n - 1] + "…" else . end;
  select(.updatedAt / 1000 > $now - 30) | .agents[]
  | [ .status,
      (.description // "" | clip(40)),
      (.summary // "" | clip(50)),
      ((((.endedAt // ($now * 1000)) - .startedAt) / 1000) | floor | tostring),
      (.toolCount // 0 | tostring),
      (if .isWorkflow then "wf" else "" end),
      (.progress.pct // "" | tostring),
      (.progress.label // "")
    ] | join("\u001f")' "$f" 2>/dev/null)
[[ -n "$rows" ]] || exit 0

n=0
while IFS=$'\x1f' read -r st desc summary secs tools wf pct plabel; do
  n=$((n + 1))
  ((n > MAX_ROWS)) && continue
  case "$st" in
    running)        mark="$(c 114)●"; dc=252; sc=223 ;;
    completed)      mark="$(c 242)✓"; dc=242; sc=242 ;;
    failed|killed)  mark="$(c 203)✗"; dc=242; sc=242 ;;
    *)              mark="$(c 179)◌"; dc=250; sc=250 ;;
  esac
  if ((secs < 60)); then took="${secs}s"; else took="$((secs / 60))m$(printf '%02d' $((secs % 60)))s"; fi
  # An empty bar keeps the columns lined up while no progress is known yet.
  printf -v label '%-5s' "$plabel"
  row="🤖 ${mark}${reset} $(graph "${pct:-0}" 114 8) $(c 245)${label}${reset}"
  row+="${wf:+ $(c 117)wf${reset}} $(c "$dc")${desc}${reset}"
  [[ -n "$summary" ]] && row+="  $(c "$sc")${summary}${reset}"
  row+="  $(c 242)${took} · ${tools} tools${reset}"
  printf '%s\n' "$row"
done <<< "$rows"
((n > MAX_ROWS)) && printf '%s\n' "🤖 $(c 242)+$((n - MAX_ROWS)) more agents${reset}"
exit 0
