/**
 * Parked Claude Agent SDK turns waiting for OpenCode tool results
 * (Cursor bridge-pool pattern).
 */
import type { ClaudeQueryHandle } from "./query.js";

export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
};

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  handle: ClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  /** SDK assistant messages whose usage was already reported to OpenCode. */
  seenAssistantUsageIds: Set<string>;
  createdAt: number;
  /** Continues consuming the SDK stream after tools resolve. */
  continueStream?: () => AsyncGenerator<unknown, void, unknown>;
};

const bridges = new Map<string, ParkedBridge>();

/**
 * How long a coexisting non-authoritative bridge may sit unresolved before
 * it's reaped. Not imported from proxy.ts's turnStallMs (would cycle back
 * into this module) — kept as a plain constant of the same order (10m).
 */
export const BRIDGE_MAX_AGE_MS = 600_000;

/**
 * One active bridge per conversation — drop any prior turn for this key,
 * unless the key came from a content hash (no session header) AND the prior
 * bridge still has unresolved tools AND it's still within BRIDGE_MAX_AGE_MS:
 * two distinct sessions can collide on that hash, and evicting a live one
 * would strand its pending tool results (which still route correctly by id
 * via findBridgeByPendingTool). Past the TTL its tools are presumed dead
 * (owning session gone) so it's reaped like any other stale bridge.
 */
export function putBridge(
  bridge: ParkedBridge,
  keyIsAuthoritative: boolean,
): void {
  const now = Date.now();
  for (const [id, existing] of bridges) {
    if (existing.conversationKey !== bridge.conversationKey || id === bridge.id) {
      continue;
    }
    const withinTtl = now - existing.createdAt <= BRIDGE_MAX_AGE_MS;
    if (!keyIsAuthoritative && existing.pendingTools.size > 0 && withinTtl) continue;
    for (const tool of existing.pendingTools.values()) {
      tool.reject(new Error("Superseded by a newer turn"));
    }
    existing.pendingTools.clear();
    try {
      existing.handle.close();
    } catch {
      // ignore
    }
    bridges.delete(id);
  }
  bridges.set(bridge.id, bridge);
}

export function getBridge(id: string): ParkedBridge | undefined {
  return bridges.get(id);
}

export function findBridgeByConversation(
  conversationKey: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.conversationKey === conversationKey) return bridge;
  }
  return undefined;
}

export function findBridgeByPendingTool(
  toolCallId: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.pendingTools.has(toolCallId)) return bridge;
  }
  return undefined;
}

export function deleteBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  for (const tool of bridge.pendingTools.values()) {
    tool.reject(new Error("Bridge closed"));
  }
  bridge.handle.close();
  bridges.delete(id);
}

export function clearAllBridges(): void {
  for (const id of [...bridges.keys()]) {
    deleteBridge(id);
  }
}
