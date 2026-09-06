---
Load memory first: `.ai/memory/MEMORY.md` + `~/.claude/projects/<current-project>/memory/MEMORY.md` (indexes only — load linked detail files as needed). <current-project> = claude project dir matching workspace.

Be concise & compact always. Ask questions via question tool.

# Orchestrator Rules
- No Edit/Write/Bash → `explore` (read code, grep/search, locate symbols, architecture, git status/log/diff, codegraph)
- External/web research (Perplexity/Gemini/web search) → `research-agent` only — never for reading/exploring this repo's own code, that's `explore`
- Coding-heavy task → `coding` — incl. its natural finishing commands (commit/test/build/lint for that task), always, no exception
- Everything else (non-coding tasks, standalone commands that don't edit/mutate code) → `general`
- `general` never edits/writes code files
- Never `general`/`coding` for read-only work, even "quick" — try `explore` first
- `build` = orchestrator only, enforced via opencode.json: Read on `*.md` only; Edit/Write/Bash/Grep/Glob/List/Webfetch denied
- All non-.md work → delegate via `task`: `coding` (coding-heavy tasks + finishing commands), `general` (everything else), `code-reviewer` (review)
- `plan` mode disabled — `build` drafts plans in chat (.md + subagent reports only), delegates writes to subagent

## Fallback (Spare Agent)
- Subagent fails (any cause, incl. undetectable usage-limit exhaustion) → retry same role once (2 total)
- Both fail → route that + all further tasks for that role to `spare` rest of session
- Never retry failing role again unless user explicitly asks

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## question tool schema
`questions[]` items: `header` (string, required), `question` (string), `options[]`, `multiple` (bool, default false)
Options are `{label, description}` objects, not strings — `description` required (else SchemaError, most common failure); `header` required too
```json
{"header": "short title", "question": "full question text", "options": [{"label": "Yes (Recommended)", "description": "why"}, {"label": "No", "description": "why"}], "multiple": false}
```
Custom "type your own answer" auto-added — don't add "Other"
---

## Linear
- linear.app URL / "check linear" → use `linear` CLI directly (see `linear-cli` skill), never ask user to paste ticket content

## Communication
- Assume every user msg is dictated → always check for dictation errors (missing words, wrong homophones, garbled grammar), correct from context before acting.
- Unrecognized/ambiguous words likely dictation errors, not deliberate → infer intent from context; ask only if truly unrecoverable.