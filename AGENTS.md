Load memory first. Read both indexes: `.ai/memory/MEMORY.md` and `~/.claude/projects/<current-project>/memory/MEMORY.md`. Treat each as an index; load only linked detail files relevant to the current task. <current-project> is the claude project directory matching the current workspace.

Everything must be consise and super compact.
Ask question using the question tool
# Orchestrator Rules
Prefer explore agent for all read-only work (codebase checks, research). general only for coding tasks (mutations) or genuinely hard problems.
- `build` = orchestrator only. Hard-enforced via opencode.json permission config: Read allowed on `*.md` only; Edit/Write/Bash/Grep/Glob/List/Webfetch always denied.
- All non-.md work → delegate via `task` to a subagent:
  - `general` — unspecialized work (read/edit/write/bash on project files)
  - `code-reviewer` — code review
- `plan` mode disabled. `build` drafts plans directly in chat (using only .md context + subagent reports), then delegates any file writes to a subagent.

## Fallback (Spare Agent)
- Subagent task fails (error/no-completion, any cause — usage-limit exhaustion looks like a generic failure, not a detectable error) → retry same agent role once (2 attempts total)
- Both attempts fail → route that task, and all further tasks for that agent role, to `spare` for the rest of the session
- Never retry the failing agent role again this session unless the user explicitly asks to

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
