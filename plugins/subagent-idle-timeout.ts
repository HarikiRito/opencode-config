import type { Plugin } from "@opencode-ai/plugin"

// Sub-agent idle-timeout plugin.
// Caps sub-agent execution with two 5min timers per session:
//   1. Per-call — fires if a single tool call runs too long
//   2. Idle — fires if no new tool calls arrive (hung session)
// Skips orchestrator ("build") sessions.

const raw = process.env.SUBAGENT_TIMEOUT_MS
const TIMEOUT_MS = raw !== undefined && Number.isFinite(Number(raw))
  ? Number(raw)
  : 5 * 60 * 1000

const callTimers = new Map<string, NodeJS.Timeout>()   // callID → timer
const idleTimers = new Map<string, NodeJS.Timeout>()   // sessionID → timer
const subagentCache = new Map<string, boolean>()        // sessionID → is-subagent
const CACHE_MAX = 1000
const setCached = (sid: string, v: boolean) => {
  if (subagentCache.size > CACHE_MAX) {
    const first = subagentCache.keys().next().value
    if (first !== undefined) subagentCache.delete(first)
  }
  subagentCache.set(sid, v)
}

export const SubagentIdleTimeoutPlugin: Plugin = async ({ client }) => {
  // Check if session belongs to a sub-agent (agent !== "build").
  // Fetches the first user message to get the agent name; caches result.
  async function isSub(sessionID: string): Promise<boolean> {
    const cached = subagentCache.get(sessionID)
    if (cached !== undefined) return cached
    try {
      const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 1 } })
      const msgs = res.data
      if (!msgs || msgs.length === 0) return false
      const msg = msgs[0].info
      if (msg.role !== "user") return false
      // UserMessage.agent is the agent name that created this session
      const result = msg.agent !== "build"
      setCached(sessionID, result)
      return result
    } catch {
      return false
    }
  }

  function abort(sessionID: string, reason: string) {
    console.error(`[idle-timeout] ${reason}`)
    client.session.abort({ path: { id: sessionID } }).catch(() => {})
  }

  return {
    "tool.execute.before": async (input) => {
      // clear idle timer first, before any await, to avoid race
      const idleTimer = idleTimers.get(input.sessionID)
      if (idleTimer) { clearTimeout(idleTimer); idleTimers.delete(input.sessionID) }

      if (!(await isSub(input.sessionID))) return

      // arm per-call timer
      const ct = setTimeout(() => {
        abort(input.sessionID, `tool ${input.tool} call ${input.callID} exceeded ${TIMEOUT_MS}ms`)
        callTimers.delete(input.callID)
      }, TIMEOUT_MS)
      callTimers.set(input.callID, ct)
    },

    "tool.execute.after": async (input) => {
      // clear per-call timer regardless
      const ct = callTimers.get(input.callID)
      if (ct) { clearTimeout(ct); callTimers.delete(input.callID) }

      if (!(await isSub(input.sessionID))) return

      // arm idle timer
      const it = setTimeout(() => {
        abort(input.sessionID, `idle ${TIMEOUT_MS}ms`)
        idleTimers.delete(input.sessionID)
      }, TIMEOUT_MS)
      idleTimers.set(input.sessionID, it)
    },
  }
}

export default SubagentIdleTimeoutPlugin
