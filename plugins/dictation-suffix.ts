import type { Plugin } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"

// Append `[dictated: check mistake]` to the first text part of real user
// messages in the MAIN conversation only. Skips:
//   - non-user messages
//   - synthetic text parts
//   - subagent sessions (Task-spawned: have Session.parentID set)
// Idempotent.
const SUFFIX = "[dictated: check mistake]"

export const DictationPrefixPlugin: Plugin = async ({ client }) => {
  // sessionID -> isSubagent. parentID immutable post-create → safe to cache.
  const subagent = new Map<string, boolean>()
  return {
    "chat.message": async (input, output) => {
      if (output.message.role !== "user") return

      if (!subagent.has(input.sessionID)) {
        const s = await client.session
          .get({ path: { id: input.sessionID } })
          .catch(() => undefined)
        if (!s?.data) return // fetch failed: skip, retry next msg
        subagent.set(input.sessionID, !!s.data.parentID)
      }
      if (subagent.get(input.sessionID)) return

      const text = output.parts.find(
        (p: Part): p is TextPart => p.type === "text" && !p.ignored && !p.synthetic,
      )
      if (!text || text.text.endsWith(SUFFIX)) return
      if (text.text.length <= 100) return
      text.text = `${text.text} ${SUFFIX}`
    },
  }
}

export default DictationPrefixPlugin
