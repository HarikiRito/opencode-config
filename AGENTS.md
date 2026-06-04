## Explore Agent Usage

Always use `explore-*` agents instead of the default `explore` agent.

**Preference order:** Prefer agents with the `-free` tag first (e.g., `explore-deepseek-free`, `explore-minimax-free`, `explore-nemotron-free`, `explore-big-pickle`), then other `explore-*` agents if free options fail.

**On error, switch to another explore agent. Do not retry.**

## General-Purpose Agent Usage

Always use `general-*` agents for implementation tasks delegated by the main orchestrator.

**Preference order:** Prefer agents with the `-free` tag first (e.g., `general-deepseek-free`, `general-minimax-free`, `general-mimo-free`), then other `general-*` agents if free options fail. Prefer in order Mimo, DeepSeek, Minimax.

**On error, switch to another general-* agent. Do not retry.**
