# Herd Workbench

A [Herdr](https://herdr.dev) layout and set of mods for working with Claude Code.
Built on Herdr 0.1.16's `main` layout.

- **Status bar** (`claude-status`): your Claude plan's 5-hour and weekly usage
  with reset countdowns, plus the focused session's context usage. Bars turn
  amber, then red, as they fill.
- **Agents list** (`my-agents`): Herdr's agents list, with each Claude session's
  context percentage.
- **Files panel** (`my-files`): a lazy file browser for the focused pane's
  folder, with read-only previews and GitHub-style syntax highlighting.
- **Changes panel** (`my-changes`): Herdr's Changes panel, extended to every git
  repository up to 3 folders below the current one, with GitHub-coloured diffs.
  Committing goes to the repository of the selected file.

The Files and Changes panels share a right-hand column, opened from the tab bar.

## What it touches outside Herdr

Read this before installing:

- `claude-status` reads your Claude Code login token from the macOS keychain
  (`security find-generic-password -s "Claude Code-credentials"`). It sends the
  token only to Anthropic's usage endpoint,
  `https://api.anthropic.com/api/oauth/usage`. That endpoint is undocumented and
  may change. It never refreshes the token.
- `claude-status` and `my-agents` read files under `~/.claude/` that the
  included status line script writes.
- `my-files` and `my-changes` run `find` and `git` in the focused terminal's
  folder and the folders below it. Committing runs `git add -A` and
  `git commit` in the selected repository.

## Install

1. Copy `layouts/herd-workbench.json` to `~/.config/herdr-app/layouts/` and the
   folders in `mods/` to `~/.config/herdr-app/mods/`. Don't overwrite anything
   you already have under the same name.
2. Install the Claude Code status line script. It needs `jq`.
   ```sh
   cp claude/statusline-usage.sh ~/.claude/ && chmod +x ~/.claude/statusline-usage.sh
   ```
   Then add this to `~/.claude/settings.json`. If you already have a
   `statusLine`, merge the two scripts instead.
   ```json
   "statusLine": { "type": "command", "command": "~/.claude/statusline-usage.sh" }
   ```
3. Check the mods, then switch to the layout:
   ```sh
   for m in claude-status my-agents my-changes my-files; do herdr-app check ~/.config/herdr-app/mods/$m; done
   herdr-app do layout.switch '{"name":"herd-workbench"}'
   ```
   `ctrl-shift-l` switches back to your previous layout.

The layout also uses Herdr's shipped `workspace-chrome`, `spaces`, `tabs` and
`pane` mods.
