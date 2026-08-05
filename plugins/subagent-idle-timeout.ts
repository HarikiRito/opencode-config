import type { Plugin } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"

// Sub-agent idle-timeout plugin + global idle watchdog.
//
// Per-session (sub-agents only, skips orchestrator "build" sessions):
//   1. Per-call — fires if a single tool call runs too long (SUBAGENT_TIMEOUT_MS)
//   2. Idle — fires if no new tool calls arrive (hung session)
// Global (all sessions, incl. main/orchestrator):
//   3. ALL_IDLE_TIMEOUT_MS — if NO agent makes any tool call for this long,
//      AUTO-CONTINUE the main (root, parentless) session instead of nagging the
//      user: inject a synthetic user message ("Continue with the task.") via
//      session.promptAsync (no `noReply`, so the LLM loop runs another turn).
//
// Auto-continue is SKIPPED when the agent is waiting on the user:
//   - the newest message is a real (non-synthetic) user message → user's turn,
//   - the newest assistant text ends with "?" → agent asked a question.
// Both leave the watchdog running; it re-checks next cycle.
//
// Safety: after MAX_AUTO_CONTINUES consecutive nudges with no progress
// (no tool calls, no real user message in between) the watchdog goes dormant
// to avoid burning tokens on a finished/stuck agent. Any real activity revives it.

const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const n = Number(raw)
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback
}
const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const n = Number(raw)
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback
}

const SUBAGENT_TIMEOUT_MS = envMs("SUBAGENT_TIMEOUT_MS", 5 * 60 * 1000)
const ALL_IDLE_TIMEOUT_MS = envMs("ALL_IDLE_TIMEOUT_MS", 600000)
const AUTO_CONTINUE_PROMPT = process.env.AUTO_CONTINUE_PROMPT ?? "Continue with the task."
const MAX_AUTO_CONTINUES = envInt("AUTO_CONTINUE_MAX", 5)

const callTimers = new Map<string, NodeJS.Timeout>()   // callID → timer
const callSessions = new Map<string, string>()          // callID → sessionID
const inFlight = new Set<string>()                      // callID → call still executing
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
  // ---- global watchdog ------------------------------------------------
  let globalTimer: NodeJS.Timeout | null = null
  let lastActiveSessionID: string | null = null
  let autoContinues = 0 // consecutive auto-continues without real progress

  // Any activity (tool call in any session, or any new message) resets the
  // watchdog. Single timer — never two at once.
  function resetGlobal(sessionID?: string) {
    if (sessionID) lastActiveSessionID = sessionID
    if (globalTimer) { clearTimeout(globalTimer); globalTimer = null }
    globalTimer = setTimeout(() => { void onGlobalIdle() }, ALL_IDLE_TIMEOUT_MS)
  }

  // The main/build session = root of the session tree (no parentID).
  // Prefer the last session that was active if it is a root, else the most
  // recently updated root session.
  async function findMainSession(): Promise<string | null> {
    if (lastActiveSessionID) {
      try {
        const res = await client.session.get({ path: { id: lastActiveSessionID } })
        if (res.data && !res.data.parentID) return lastActiveSessionID
      } catch {
        // deleted/unknown — fall through to list
      }
    }
    try {
      const res = await client.session.list()
      const roots = (res.data ?? []).filter((s) => !s.parentID)
      if (roots.length === 0) return null
      roots.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      return roots[0].id
    } catch (err) {
      console.error(`[idle-timeout] failed to list sessions: ${String(err)}`)
      return null
    }
  }

  // True when the agent is waiting on the user, scanning newest → oldest:
  //   - newest real (non-synthetic) user message → user's turn
  //   - newest assistant text ends with "?" → question asked
  async function agentWaitingForInput(sessionID: string): Promise<boolean> {
    try {
      const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
      const msgs = res.data ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const { info, parts } = msgs[i]
        if (info.role === "user") {
          // real user message = any non-text part, or a text part that isn't synthetic
          if (parts.some((p) => p.type !== "text" || !p.synthetic)) return true
          continue // our own synthetic nudge — keep scanning
        }
        const text = parts
          .filter((p): p is TextPart => p.type === "text" && !p.ignored)
          .map((p) => p.text)
          .join(" ")
          .trim()
        if (text.length > 0) return /\?\s*$/.test(text)
      }
      return false
    } catch {
      return false
    }
  }

  // Send a synthetic user message that makes the main agent take another turn.
  // Reuses the session's current agent so the session isn't switched mid-task;
  // `synthetic: true` marks it as programmatic (skips title generation, and
  // lets us distinguish our nudges from real user input).
  async function autoContinue(sessionID: string) {
    let agent: string | undefined
    try {
      const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
      const msgs = res.data ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i].info
        if (info.role === "user") {
          agent = info.agent
          break
        }
      }
    } catch {
      // fall back to server default agent
    }
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        ...(agent ? { agent } : {}),
        parts: [{ type: "text", text: AUTO_CONTINUE_PROMPT, synthetic: true }],
      },
    })
  }

  async function onGlobalIdle() {
    globalTimer = null
    const sid = await findMainSession()
    if (!sid) {
      console.error(`[idle-timeout] no main (root) session found — watchdog idle`)
      resetGlobal()
      return
    }
    if (await agentWaitingForInput(sid)) {
      console.error(`[idle-timeout] agent is waiting for user input — not auto-continuing (${sid})`)
      resetGlobal(sid) // keep watching; re-check next cycle
      return
    }
    if (autoContinues >= MAX_AUTO_CONTINUES) {
      console.error(`[idle-timeout] ${MAX_AUTO_CONTINUES} consecutive auto-continues with no progress — watchdog dormant (${sid})`)
      return // no timer: stays dormant until real activity revives it
    }
    autoContinues++
    try {
      // await autoContinue(sid)
      // console.error(`[idle-timeout] auto-continued main session ${sid} (nudge ${autoContinues}/${MAX_AUTO_CONTINUES})`)
    } catch (err) {
      console.error(`[idle-timeout] failed to auto-continue session ${sid}: ${String(err)}`)
    }
    resetGlobal(sid)
  }

  // ---- per-session helpers --------------------------------------------
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
    const it = idleTimers.get(sessionID)
    if (it) { clearTimeout(it); idleTimers.delete(sessionID) }
    client.session.abort({ path: { id: sessionID } }).catch(() => {})
  }

  // Clear every timer + cache entry owned by a (deleted) session.
  function cleanupSession(sessionID: string) {
    const it = idleTimers.get(sessionID)
    if (it) { clearTimeout(it); idleTimers.delete(sessionID) }
    subagentCache.delete(sessionID)
    for (const [callID, sid] of callSessions) {
      if (sid !== sessionID) continue
      const ct = callTimers.get(callID)
      if (ct) { clearTimeout(ct); callTimers.delete(callID) }
      callSessions.delete(callID)
      inFlight.delete(callID)
    }
  }

  return {
    // session cleanup — drop timers/cache of deleted sessions
    event: async ({ event }) => {
      if (event.type === "session.deleted") cleanupSession(event.properties.info.id)
    },

    // Any new message (user reply or agent turn) counts as activity for the
    // global watchdog — prevents nudging right after the user already answered.
    // A real (non-synthetic) user message also resets the nudge budget.
    "chat.message": async (input, output) => {
      resetGlobal(input.sessionID)
      // real (non-synthetic) user message → fresh nudge budget
      if (output?.parts?.some((p: Part) => p.type !== "text" || !p.synthetic)) autoContinues = 0
    },

    "tool.execute.before": async (input) => {
      // 1) global watchdog — every tool call in ANY session resets it;
      //    real work also resets the nudge budget
      resetGlobal(input.sessionID)
      autoContinues = 0

      // 2) per-session bookkeeping — synchronous, before any await
      const idleTimer = idleTimers.get(input.sessionID)
      if (idleTimer) { clearTimeout(idleTimer); idleTimers.delete(input.sessionID) }
      inFlight.add(input.callID)
      callSessions.set(input.callID, input.sessionID)

      if (!(await isSub(input.sessionID))) return

      // Call may have completed while isSub() awaited — don't arm a stale timer
      if (!inFlight.has(input.callID)) return

      // arm per-call timer
      const ct = setTimeout(() => {
        abort(input.sessionID, `tool ${input.tool} call ${input.callID} exceeded ${SUBAGENT_TIMEOUT_MS}ms`)
        callTimers.delete(input.callID)
        callSessions.delete(input.callID)
        inFlight.delete(input.callID)
      }, SUBAGENT_TIMEOUT_MS)
      callTimers.set(input.callID, ct)
    },

    "tool.execute.after": async (input) => {
      inFlight.delete(input.callID)
      callSessions.delete(input.callID)
      // clear per-call timer regardless
      const ct = callTimers.get(input.callID)
      if (ct) { clearTimeout(ct); callTimers.delete(input.callID) }

      if (!(await isSub(input.sessionID))) return

      // arm idle timer
      const it = setTimeout(() => {
        abort(input.sessionID, `idle ${SUBAGENT_TIMEOUT_MS}ms`)
        idleTimers.delete(input.sessionID)
      }, SUBAGENT_TIMEOUT_MS)
      idleTimers.set(input.sessionID, it)
    },
  }
}

export default SubagentIdleTimeoutPlugin
