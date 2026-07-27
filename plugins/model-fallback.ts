import type { Plugin } from "@opencode-ai/plugin"
import type {
  AgentPartInput,
  ApiError,
  FilePartInput,
  MessageAbortedError,
  MessageOutputLengthError,
  Part,
  ProviderAuthError,
  TextPartInput,
  UnknownError,
} from "@opencode-ai/sdk"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Model Fallback Plugin
//
// On session.error (auth/rate-limit/5xx/unknown), resends the last user
// message against a fallback model instead of leaving the session dead.
// Opt-in per agent via a custom `fallback_models:` frontmatter list in
// agents/<name>.md — agents without it are untouched.

const TTL = 300_000 // 5min retry-chain window; arbitrary, same order as other retry-guard TTLs

type FallbackChain = { providerID: string; modelID: string }[]
type FallbackState = { chain: FallbackChain; index: number; ts: number; consecutiveApiErrors: number }

// module-scope so state survives across event calls within the process
const sessionState = new Map<string, FallbackState>()

// evicts entries older than TTL — keeps map bounded on long-running hosts
function pruneSessionState(): void {
  const now = Date.now()
  for (const [sessionID, state] of sessionState) {
    if (now - state.ts > TTL) sessionState.delete(sessionID)
  }
}

type SessionErrorInfo =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | ApiError

// how many consecutive retryable APIErrors (per session) before we actually fall back
const RETRYABLE_API_ERROR_THRESHOLD = 3

type ErrorKind = "immediate" | "counted" | "skip"

// ProviderAuthError/UnknownError: provider genuinely broken -> immediate.
// APIError w/ isRetryable: may be a transient blip -> counted, not immediate.
// everything else: skip.
function classifyError(error: SessionErrorInfo): ErrorKind {
  if (error.name === "ProviderAuthError" || error.name === "UnknownError") return "immediate"
  if (error.name === "APIError" && error.data.isRetryable === true) return "counted"
  return "skip"
}

function findAgentFile(worktree: string | undefined, agentName: string): string | undefined {
  const candidates = [
    ...(worktree ? [join(worktree, ".opencode", "agents", `${agentName}.md`)] : []),
    join(homedir(), ".config", "opencode", "agents", `${agentName}.md`),
  ]
  return candidates.find((p) => existsSync(p))
}

// strips a trailing ` #...` yaml comment (# only counts when whitespace-preceded)
function stripTrailingComment(s: string): string {
  return s.replace(/\s+#.*$/, "").trim()
}

// parses `fallback_models:` from frontmatter — inline array or yaml block-list
function parseFallbackModels(raw: string): FallbackChain {
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (!frontmatterMatch) return []
  const frontmatter = frontmatterMatch[1]

  const inlineMatch = frontmatter.match(/^fallback_models:\s*\[(.*)\]\s*$/m)
  let entries: string[] = []
  if (inlineMatch) {
    entries = inlineMatch[1]
      .split(",")
      .map((s) => stripTrailingComment(s.trim()).replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  } else {
    const blockMatch = frontmatter.match(/^fallback_models:\s*\n((?:\s*-\s*.+\n?)+)/m)
    if (blockMatch) {
      entries = [...blockMatch[1].matchAll(/^\s*-\s*(.+)\s*$/gm)].map((m) =>
        stripTrailingComment(m[1].trim()).replace(/^["']|["']$/g, ""),
      )
    }
  }

  return entries
    .map((entry) => {
      const idx = entry.indexOf("/")
      if (idx === -1) return undefined
      return { providerID: entry.slice(0, idx), modelID: entry.slice(idx + 1) }
    })
    .filter((x): x is FallbackChain[number] => !!x)
}

// maps stored Parts -> the *Input shapes session.prompt expects
function toPartInput(part: Part): TextPartInput | FilePartInput | AgentPartInput | undefined {
  if (part.type === "text") return { type: "text", text: part.text }
  if (part.type === "file") return { type: "file", mime: part.mime, filename: part.filename, url: part.url }
  if (part.type === "agent") return { type: "agent", name: part.name }
  return undefined
}

export const ModelFallbackPlugin: Plugin = async ({ client, worktree }) => {
  return {
    "chat.params": async (_input, output) => {
      // custom frontmatter field leaks into provider options — strip it
      if (output.options && "fallback_models" in output.options) {
        delete output.options.fallback_models
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type !== "session.error") return
        const { sessionID, error } = event.properties
        if (!sessionID || !error) return
        pruneSessionState()
        const kind = classifyError(error)
        if (kind === "skip") return // abort/output-length/non-retryable APIError

        const res = await client.session.messages({ path: { id: sessionID } })
        const messages = res.data
        if (!messages) return

        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.info.role === "assistant")
        if (!lastAssistant) return
        const assistantInfo = lastAssistant.info as Extract<typeof lastAssistant.info, { role: "assistant" }>

        const parentUser = messages.find((m) => m.info.id === assistantInfo.parentID)
        if (!parentUser || parentUser.info.role !== "user") return
        const agentName = parentUser.info.agent
        if (!agentName) return

        const agentFile = findAgentFile(worktree, agentName)
        if (!agentFile) return

        const chain = parseFallbackModels(readFileSync(agentFile, "utf-8"))
        if (chain.length === 0) return

        let state = sessionState.get(sessionID)
        if (!state || Date.now() - state.ts > TTL) {
          state = { chain, index: 0, ts: Date.now(), consecutiveApiErrors: 0 }
        }

        if (kind === "immediate") {
          state.consecutiveApiErrors = 0 // unrelated failure signal — doesn't count toward API-error streak
        } else {
          state.consecutiveApiErrors += 1
          if (state.consecutiveApiErrors < RETRYABLE_API_ERROR_THRESHOLD) {
            state.ts = Date.now()
            sessionState.set(sessionID, state)
            return // transient blip — wait for more consecutive occurrences before falling back
          }
          state.consecutiveApiErrors = 0
        }

        if (state.index >= chain.length) {
          sessionState.set(sessionID, state)
          return // chain exhausted
        }

        const fallbackModel = chain[state.index]
        state.index += 1
        state.ts = Date.now()
        sessionState.set(sessionID, state)

        const mappedParts = parentUser.parts
          .map(toPartInput)
          .filter((p): p is NonNullable<typeof p> => !!p)
        if (mappedParts.length === 0) return

        await client.session.prompt({
          path: { id: sessionID },
          body: { model: fallbackModel, agent: agentName, parts: mappedParts },
        })
      } catch (err) {
        console.error("[model-fallback] failed to handle session.error", err)
      }
    },
  }
}

export default ModelFallbackPlugin
