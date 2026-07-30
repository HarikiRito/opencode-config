import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/**
 * Skills as Plain Text Commands Plugin
 *
 * Registers custom skills as slash commands in the TUI,
 * but returns only "Skill: <name>" instead of expanding the full skill content.
 *
 */
export default (async ({ worktree }) => {
  const home = homedir()

  const skillDirs = worktree
    ? [
        join(worktree, ".opencode", "skills"),
        join(worktree, ".claude", "skills"),
        join(worktree, ".agents", "skills"),
      ]
    : []

  const globalSkillDirs = [
    join(home, ".config", "opencode", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
  ]

  const allSkillDirs = [...skillDirs, ...globalSkillDirs]

  // Scan all skill directories and collect skill metadata
  const commands: Record<string, { template: string; description: string }> = {}

  for (const dir of allSkillDirs) {
    if (!existsSync(dir)) continue

    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue

        const skillPath = join(dir, entry.name, "SKILL.md")
        if (!existsSync(skillPath)) continue

        try {
          const raw = readFileSync(skillPath, "utf-8")
          // Simple frontmatter parsing
          const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)

          if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1]
            // const content = frontmatterMatch[2]

            // Parse name and description from frontmatter
            const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
            const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

            const name = nameMatch?.[1]?.trim()
            const description = descMatch?.[1]?.trim()

            if (name && description) {
              // Register as command but with plain text template
              // commands[name] = {
              //   template: `SKILL: ${name}`,
              //   description,
              // }
            }
          }
        } catch {
          // Skip skills that can't be read
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      Object.assign(cfg.command, commands)
    },
  }
}) satisfies Plugin
