@AGENTS.md

## Claude Code notes

- `AGENTS.md` (imported above) is the shared, canonical guidance for both Codex and Claude Code. Edit it, not this file.
- `$twin-plan` and `$twin-verify` are the Claude skills `twin-plan` and `twin-verify`. `.claude/skills/` symlinks to `.agents/skills/`, so both tools read the same files.
- `twin_explorer`, `twin_builder`, and `twin_reviewer` are the subagents `twin-explorer`, `twin-builder`, and `twin-reviewer` in `.claude/agents/`. They mirror `.codex/agents/*.toml`; keep the two in sync.

## Claude Code overrides (Leo's instructions, 2026-10-30)

These apply to Claude Code only and take precedence over the matching `AGENTS.md` rules. Codex keeps its sandbox.

- Claude is not sandboxed here. Network access and actions outside the repo are allowed when the task needs them.
- Claude may `git commit` and `git push` to `origin` (github.com/leosusser/twin) without asking first. Commit only intended changes, never `.env` or secrets, and say in the handoff what was pushed.
- Never force-push or rewrite pushed history unless Leo asks.
- Use the `frontend-design` skill for UI work in `public/`.
