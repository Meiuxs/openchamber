import type { WorkflowRun } from "@/lib/workflows/model"
import type {
  FilePart,
  FormRequest,
  JsonValue,
  Message,
  Metadata,
  ModelRef,
  Part,
  PermissionRequest,
  PermissionRuleset,
  Session,
  SessionStatus,
  SessionOutcome,
  StructuredError,
  TokenUsageInfo,
} from "./model"
import type { RunningShell, ShellEnd } from "./background-shell"
import type { ImageJobUpdate } from "./background-image"

export type SessionPatch = {
  title?: string
  directory?: string
  projectID?: string
  subpath?: string | null
  agent?: string
  model?: ModelRef
  cost?: number
  tokens?: TokenUsageInfo
  permissions?: PermissionRuleset
  revert?: Session["revert"] | null
  outcome?: Session["outcome"]
  metadata?: Metadata
  time?: Partial<Omit<Session["time"], "archived">> & { archived?: number | null }
}

export type MessagePatch = {
  time?: { created?: number; firstToken?: number; streamed?: number; completed?: number }
  finish?: Extract<Message, { role: "assistant" }>["finish"]
  error?: StructuredError
  cost?: number
  tokens?: TokenUsageInfo
  snapshot?: { start?: string; end?: string; files?: string[] }
  retry?: Extract<Message, { role: "assistant" }>["retry"] | null
  shell?: { status: "running" | "exited" | "timeout" | "killed"; exit?: number; signal?: string; output?: Extract<Message, { role: "shell" }>["output"] }
}

export type ToolTransition =
  | { kind: "input"; raw: string }
  | { kind: "called"; input: Record<string, JsonValue>; executed: boolean; start: number }
  | { kind: "progress"; metadata: Metadata }
  | { kind: "success"; output: string; attachments?: FilePart[]; metadata?: Metadata; executed: boolean; end: number }
  | { kind: "failed"; error: string; errorType?: string; output?: string; metadata?: Metadata; executed: boolean; end: number }

export type CatalogKind =
  | "config"
  | "agent"
  | "command"
  | "skill"
  | "plugin"
  | "provider"
  | "model"
  | "credential"
  | "project"
  | "websearch"

export type SessionTurnStart = { at: number; source: "host" | "live" }

export const hostTurnStart = (startedAt: number, hostNow: number): SessionTurnStart => ({
  at: Date.now() - Math.max(0, hostNow - startedAt),
  source: "host",
})

export type SyncEvent =
  | { type: "server.connected"; properties: Record<never, never> }
  | { type: "installation.update-available"; properties: { version: string } }
  | { type: "session.created"; properties: { info: Session } }
  | { type: "session.patched"; properties: { sessionID: string; patch: SessionPatch } }
  | { type: "session.deleted"; properties: { sessionID: string } }
  // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Fork events carry IDs without a session.created event; sync fetches the fork record.
  | { type: "session.forked"; properties: { sessionID: string; parentID: string } }
  // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Committing a revert removes the boundary and later messages without message.removed events.
  | { type: "session.revert.committed"; properties: { sessionID: string; to: string } }
  | { type: "session.status"; properties: { sessionID: string; status: SessionStatus; turnStart?: SessionTurnStart } }
  | { type: "session.idle"; properties: { sessionID: string; outcome?: SessionOutcome } }
  | { type: "session.error"; properties: { sessionID: string; error: StructuredError } }
  | { type: "message.updated"; properties: { info: Message } }
  | { type: "message.patched"; properties: { sessionID: string; messageID: string; patch: MessagePatch } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { type: "message.part.updated"; properties: { sessionID: string; part: Part } }
  | { type: "message.part.delta"; properties: { sessionID: string; messageID: string; partID: string; field: "text" | "raw"; delta: string } }
  | { type: "message.tool.transition"; properties: { sessionID: string; messageID: string; partID: string; transition: ToolTransition } }
  | { type: "message.parts.replaced"; properties: { sessionID: string; messageID: string; parts: Part[]; whilePending?: true } }
  | { type: "message.compaction.delta"; properties: { sessionID: string; delta: string } }
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string } }
  | { type: "form.created"; properties: { form: FormRequest } }
  | {
    type: "form.settled"
    properties: {
      sessionID: string
      formID: string
      disposition?: "replied" | "cancelled"
    }
  }
  | { type: "shell.started"; properties: { shell: RunningShell } }
  | { type: "shell.ended"; properties: { shellID: string; end: ShellEnd; endedAt: number } }
  | { type: "image.job.updated"; properties: ImageJobUpdate }
  | { type: "vcs.branch.updated"; properties: { branch?: string } }
  | { type: "filesystem.changed"; properties: { file: string } }
  | { type: "mcp.status.changed"; properties: { server: string } }
  | { type: "catalog.updated"; properties: { kind: CatalogKind } }
  | { type: "location.shutdown"; properties: Record<never, never> }
  | { type: "openchamber.notification"; properties: OpenchamberNotification }
  | { type: "openchamber.permission-auto-accept"; properties: { sessions: Record<string, boolean>; modes?: Record<string, "ask" | "safety" | "auto">; revision?: number; spaceId?: string } }
  | { type: "openchamber.permission-left-for-user"; properties: { permissionId: string; sessionId: string; directory: string | null; spaceId?: string } }
  | { type: "openchamber.page-waiting"; properties: { sessionID: string; directory: string | null; page: { id: string; title: string } } }
  | { type: "openchamber.page-settled"; properties: { sessionID: string; pageID: string } }
  | { type: "openchamber.session-assist"; properties: { sessionID: string; directory: string | null; pending: boolean } }
  | { type: "openchamber.workflow-run"; properties: { run: WorkflowRun } }
  | { type: "openchamber.workflow-run-removed"; properties: { runId: string; parentSessionId: string } }

export type OpenchamberNotification = {
  kind?: string
  sessionId?: string
  directory?: string
  itemUrl?: string
  title?: string
  body?: string
  tag?: string
  requireHidden?: boolean
  showWhenFocused?: boolean
  toastOnly?: boolean
  desktopNotificationDelivered?: boolean
  desktopStdoutActive?: boolean
}

export type RoutedSyncEvent = {
  directory: string
  event: SyncEvent
}
