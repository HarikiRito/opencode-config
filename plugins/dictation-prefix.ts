import type { Plugin } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"

// Dictation-prefix plugin.
// Prepend `[dictated: check mistake]` to the first text part of every real
// user message, so the assistant sanity-checks dictated wording. Skips:
//   - non-user messages (role via output.message)
//   - synthetic messages (text parts with `synthetic: true`)
// Idempotent: never double-prefixes.

const PREFIX = "[dictated: check mistake]"

export const DictationPrefixPlugin: Plugin = async () => {
  return {
    "chat.message": async (_input, output) => {
      if (output.message.role !== "user") return
      const text = output.parts.find(
        (p: Part): p is TextPart => p.type === "text" && !p.ignored && !p.synthetic,
      )
      if (!text || text.text.startsWith(PREFIX)) return
      text.text = `${PREFIX} ${text.text}`
    },
  }
}

export default DictationPrefixPlugin
