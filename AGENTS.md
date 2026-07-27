# Orchestrator Rules

- `build` = orchestrator only. Hard-enforced via opencode.json permission config: Read allowed on `*.md` only; Edit/Write/Bash/Grep/Glob/List/Webfetch always denied.
- All non-.md work → delegate via `task` to a subagent:
  - `general` — unspecialized work (read/edit/write/bash on project files)
  - `code-reviewer` — code review
  - `goal-verifier` — verify plan goals achieved
  - `user-feedback` — persona-based feature critique
- `plan` mode disabled. `build` drafts plans directly in chat (using only .md context + subagent reports), then delegates any file writes to a subagent.
