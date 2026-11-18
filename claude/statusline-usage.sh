#!/bin/sh
# Claude Code status line. Saves, for the herdr status bar and agents list
# (mods/claude-status, mods/my-agents):
# - the 5-hour / weekly rate limits (fallback for Claude's usage API), and
# - this session's context window usage, per herdr terminal (HC_TERMINAL_ID).
input=$(cat)
cache="$HOME/.claude/usage-cache.json"
limits=$(printf '%s' "$input" | jq -c 'select(.rate_limits != null) | {rate_limits, captured_at: now}' 2>/dev/null)
if [ -n "$limits" ]; then
  printf '%s\n' "$limits" > "$cache.tmp" && mv "$cache.tmp" "$cache"
fi
if [ -n "$HC_TERMINAL_ID" ]; then
  dir="$HOME/.claude/herdr-context"
  mkdir -p "$dir"
  ctx=$(printf '%s' "$input" | jq -c 'select(.context_window != null) | {context_window, session_id, captured_at: now}' 2>/dev/null)
  if [ -n "$ctx" ]; then
    file="$dir/$HC_TERMINAL_ID.json"
    printf '%s\n' "$ctx" > "$file.tmp" && mv "$file.tmp" "$file"
  fi
  # Terminals are reused by id; drop files of sessions gone for over a day.
  find "$dir" -name '*.json' -mtime +1 -delete 2>/dev/null
fi
# Claude Code's own status line shows just the model.
printf '%s' "$input" | jq -r '.model.display_name // ""' 2>/dev/null
