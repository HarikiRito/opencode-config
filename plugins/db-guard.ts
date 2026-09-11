import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ---- tunables ----
const DB_CLIENT =
  /\b(psql|pgcli|mysql|mariadb|mysqlsh|sqlite3|sqlcmd|mongosh|mongo|redis-cli|clickhouse-client|clickhouse|duckdb|dbcli|isql|usql)\b/
const CONN_STRING =
  /((postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|sqlite3?|sqlserver):\/\/|jdbc:[a-z0-9]+:)/
const MUTATION =
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|MERGE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER)\b|\b(insert|update|delete|replace)(One|Many)\b|\bbulkWrite\b|\bdropDatabase\b/i

const GLOBAL_FLAG = join(homedir(), ".config", "opencode", "db-guard.toml")
const GUARD_PATH_RE = /(^|\/)(\.ai\/config\.toml|db-guard\.toml)$/
const WRITE_OP = /(>>?|tee\b|sed -i|perl -i|-pi\b|\brm\b|\bmv\b|\bcp\b)/

// never echo credentials back into error text/logs
function redact(s: string): string {
  return s
    .replace(/(PGPASSWORD\s*=\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, "$1****")
    .replace(/(-p|--password[= ])\s*("[^"]*"|'[^']*'|[^\s]+)/g, "$1****")
    .replace(/(password\s*=\s*)("[^"]*"|'[^']*'|[^\s&]+)/gi, "$1****")
    .replace(
      /((?:postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|sqlite3?|sqlserver):\/\/[^:/@\s]+:)[^@\s]+@/gi,
      "$1****@",
    )
}

// first existing file wins; missing key or missing file = false (read-only).
// deliberately NOT .opencode/ — that dir is a functional opencode root and is
// scanned/precedence-shadowed; .ai/ is inert. known gap: mutation SQL inside a
// piped FILE (cat f.sql | psql) or psql \i is invisible here.
function mutationsAllowed(root: string): boolean {
  const candidates = [join(root, ".ai", "config.toml"), GLOBAL_FLAG]
  for (const f of candidates) {
    try {
      if (!existsSync(f)) continue
      const m = readFileSync(f, "utf8").match(/^\s*db_mutation\s*=\s*(true|false)\s*(?:#.*)?$/m)
      return m ? m[1] === "true" : false
    } catch {}
  }
  return false
}

export default (async (input) => {
  const root = input.worktree || input.directory || process.cwd()
  return {
    "tool.execute.before": async (toolInput: any, output: any) => {
      const tool = toolInput.tool as string

      // guard policy files are user-only: agents may not write/edit/delete them
      if (tool === "bash") {
        const cmd: string = output.args?.command ?? ""
        if (!cmd) return
        if (GUARD_PATH_RE.test(cmd) && WRITE_OP.test(cmd))
          throw new Error(
            "db-guard: agents may not modify db-guard policy files. Only the user may change db_mutation.",
          )
        const isDb = DB_CLIENT.test(cmd) || CONN_STRING.test(cmd)
        if (!isDb || !MUTATION.test(cmd)) return
        if (mutationsAllowed(root)) return
        throw new Error(
          [
            "db-guard: BLOCKED — database mutation while in read-only mode.",
            `command (redacted): ${redact(cmd).slice(0, 200)}`,
            "This is enforced by policy. Do NOT retry this or any other mutation SQL (INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/...) against any database, and do not attempt to bypass via other clients, heredocs, or files. Read-only statements (SELECT/SHOW/EXPLAIN) are allowed.",
            `Mutations become possible only when the USER sets 'db_mutation = true' in ${join(root, ".ai", "config.toml")} or ${GLOBAL_FLAG}. Agents must not edit those files.`,
          ].join("\n"),
        )
      }

      if (tool === "edit" || tool === "write") {
        const file: string = output.args?.file ?? output.args?.filePath ?? ""
        if (file && GUARD_PATH_RE.test(file))
          throw new Error(
            "db-guard: agents may not edit db-guard policy files. Only the user may change db_mutation.",
          )
      }
    },
  }
}) satisfies Plugin
