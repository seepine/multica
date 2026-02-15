import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { SessionEntry, SessionMeta } from "./types.js";
import { appendEntry, readEntries, resolveSessionPath, writeEntries } from "./storage.js";
import { compactMessages, compactMessagesAsync, type CompactionResult } from "./compaction.js";
import { estimateTokenUsage, estimateMessagesTokens, shouldCompact as shouldCompactTokens } from "../context-window/index.js";
import { credentialManager } from "../credentials.js";
import { repairSessionFileIfNeeded, type RepairReport } from "./session-file-repair.js";
import { sanitizeToolCallInputs, sanitizeToolUseResultPairing } from "./session-transcript-repair.js";
import {
  pruneToolResults,
  type ToolResultPruningSettings,
} from "../context-window/tool-result-pruning.js";
import {
  truncateOversizedToolResults,
  type ToolResultTruncationSettings,
} from "../context-window/tool-result-truncation.js";
import { saveToolResultArtifact } from "./artifact-store.js";
import type { RunLog } from "../run-log.js";

/** Get Kimi model for summarization (use a cheaper model than k2-thinking) */
function getSummaryModel(): Model<any> {
  return (getModel as (p: string, m: string) => Model<any>)("kimi", "moonshot-v1-128k");
}

/** Get Kimi API key */
function getSummaryApiKey(): string | undefined {
  const providers = ["kimi", "moonshot", "kimi-coding"];
  for (const provider of providers) {
    const apiKey = credentialManager.getLlmProviderConfig(provider)?.apiKey;
    if (apiKey) return apiKey;
  }
  return undefined;
}

export type SessionManagerOptions = {
  sessionId: string;
  baseDir?: string | undefined;

  // Compaction mode configuration
  /** Compaction mode: "tokens" uses token awareness, "summary" uses LLM summary (default) */
  compactionMode?: "tokens" | "summary" | undefined;

  // Token mode parameters
  /** Context window token count */
  contextWindowTokens?: number | undefined;
  /** System prompt (used to calculate available tokens) */
  systemPrompt?: string | undefined;
  /** Tokens reserved for responses */
  reserveTokens?: number | undefined;
  /** Compaction target utilization ratio (0-1) */
  targetRatio?: number | undefined;
  /** Minimum messages to keep */
  minKeepMessages?: number | undefined;

  // Summary mode parameters
  /** LLM Model (for generating summary) */
  model?: Model<any> | undefined;
  /** API Key */
  apiKey?: string | undefined;
  /** Custom summary instructions */
  customInstructions?: string | undefined;

  // Tool result pruning
  /** Whether to enable tool result pruning before compaction (default: true) */
  enableToolResultPruning?: boolean | undefined;
  /** Tool result pruning settings */
  toolResultPruning?: Partial<ToolResultPruningSettings> | undefined;

  // Pre-emptive tool result truncation
  /** Whether to enable pre-emptive truncation of oversized tool results (default: true) */
  enableToolResultTruncation?: boolean | undefined;
  /** Pre-emptive truncation settings */
  toolResultTruncation?: Partial<ToolResultTruncationSettings> | undefined;

  // Observability
  /** RunLog instance for structured logging */
  runLog?: RunLog | undefined;
};

export class SessionManager {
  private readonly sessionId: string;
  private readonly baseDir: string | undefined;
  private readonly compactionMode: "tokens" | "summary";
  // Token mode
  private readonly contextWindowTokens: number;
  private systemPrompt: string | undefined;
  private readonly reserveTokens: number;
  private readonly targetRatio: number;
  private readonly minKeepMessages: number;
  // Summary mode
  private model: Model<any> | undefined;
  private apiKey: string | undefined;
  private readonly customInstructions: string | undefined;
  private previousSummary: string | undefined;
  // Tool result pruning
  private readonly enableToolResultPruning: boolean;
  private readonly toolResultPruning: Partial<ToolResultPruningSettings> | undefined;
  // Pre-emptive truncation
  private readonly enableToolResultTruncation: boolean;
  private readonly toolResultTruncation: Partial<ToolResultTruncationSettings> | undefined;
  // Observability
  private readonly runLog: RunLog;

  private queue: Promise<void> = Promise.resolve();
  private meta: SessionMeta | undefined;

  constructor(options: SessionManagerOptions) {
    this.sessionId = options.sessionId;
    this.baseDir = options.baseDir;

    // Compaction mode (default: summary with LLM-based summarization)
    this.compactionMode = options.compactionMode ?? "summary";

    // Token mode parameters
    this.contextWindowTokens = options.contextWindowTokens ?? 200_000;
    this.systemPrompt = options.systemPrompt;
    this.reserveTokens = options.reserveTokens ?? 1024;
    this.targetRatio = options.targetRatio ?? 0.5;
    this.minKeepMessages = options.minKeepMessages ?? 10;

    // Summary mode parameters
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.customInstructions = options.customInstructions;

    // Tool result pruning (enabled by default)
    this.enableToolResultPruning = options.enableToolResultPruning ?? true;
    this.toolResultPruning = options.toolResultPruning;

    // Pre-emptive truncation (enabled by default)
    this.enableToolResultTruncation = options.enableToolResultTruncation ?? true;
    this.toolResultTruncation = options.toolResultTruncation;

    // Observability
    this.runLog = options.runLog ?? { log() {}, async flush() {} };

    this.meta = this.loadMeta();
  }

  /**
   * Update system prompt (for token mode calculation)
   */
  setSystemPrompt(systemPrompt: string | undefined) {
    this.systemPrompt = systemPrompt;
  }

  /**
   * Get current context window token count
   */
  getContextWindowTokens(): number {
    return this.contextWindowTokens;
  }

  /**
   * Set LLM Model (for summary mode)
   */
  setModel(model: Model<any> | undefined) {
    this.model = model;
  }

  /**
   * Set API Key (for summary mode)
   */
  setApiKey(apiKey: string | undefined) {
    this.apiKey = apiKey;
  }

  /**
   * Get current compaction mode
   */
  getCompactionMode(): "tokens" | "summary" {
    return this.compactionMode;
  }

  loadEntries(): SessionEntry[] {
    return readEntries(this.sessionId, { baseDir: this.baseDir });
  }

  async repairIfNeeded(warn?: (message: string) => void): Promise<RepairReport> {
    const filePath = resolveSessionPath(this.sessionId, { baseDir: this.baseDir });
    return repairSessionFileIfNeeded({ sessionFile: filePath, ...(warn !== undefined ? { warn } : {}) });
  }

  loadMessages(options?: { includeInternal?: boolean }): AgentMessage[] {
    return this.loadMessagesFromEntries(options, false);
  }

  loadMessagesForDisplay(options?: { includeInternal?: boolean }): (AgentMessage & { source?: import("./types.js").MessageSource })[] {
    return this.loadMessagesFromEntries(options, true);
  }

  private loadMessagesFromEntries(
    options: { includeInternal?: boolean } | undefined,
    preferDisplayContent: boolean,
  ): (AgentMessage & { source?: import("./types.js").MessageSource })[] {
    const entries = this.loadEntries();
    let messages = entries
      .filter((entry) => {
        if (entry.type !== "message") return false;
        if (!options?.includeInternal && entry.internal) return false;
        return true;
      })
      .map((entry) => {
        const messageEntry = entry as Extract<SessionEntry, { type: "message" }>;
        const base = preferDisplayContent
          && messageEntry.message.role === "user"
          && messageEntry.displayContent !== undefined
          ? { ...messageEntry.message, content: messageEntry.displayContent }
          : messageEntry.message;
        // Include source for user messages
        if (messageEntry.source && messageEntry.message.role === "user") {
          return { ...base, source: messageEntry.source };
        }
        return base;
      });
    messages = sanitizeToolCallInputs(messages) as typeof messages;
    messages = sanitizeToolUseResultPairing(messages) as typeof messages;
    return messages;
  }

  loadMeta(): SessionMeta | undefined {
    const entries = this.loadEntries();
    let meta: SessionMeta | undefined;
    for (const entry of entries) {
      if (entry.type === "meta") {
        meta = entry.meta;
      }
    }
    return meta;
  }

  getMeta(): SessionMeta | undefined {
    return this.meta;
  }

  saveMeta(meta: SessionMeta) {
    this.meta = meta;
    void this.enqueue(() =>
      appendEntry(
        this.sessionId,
        { type: "meta", meta, timestamp: Date.now() },
        { baseDir: this.baseDir },
      ),
    );
  }

  saveMessage(
    message: AgentMessage,
    options?: { internal?: boolean; displayContent?: UserMessage["content"]; source?: import("./types.js").MessageSource },
  ) {
    // Pre-emptive truncation: save oversized tool results as artifacts
    // and persist a truncated version in the JSONL session file.
    let persistMessage = message;
    if (this.enableToolResultTruncation && message.role === "user") {
      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: this.contextWindowTokens,
        settings: this.toolResultTruncation,
        saveArtifact: (toolCallId, content) =>
          saveToolResultArtifact(this.sessionId, toolCallId, content, { baseDir: this.baseDir }),
      });
      if (result.truncated) {
        persistMessage = result.message;
        for (const art of result.artifacts) {
          this.runLog.log("tool_result_truncation", {
            tool_call_id: art.toolCallId,
            tool_name: art.toolName,
            original_chars: art.originalChars,
            artifact_path: art.artifactRelPath,
          });
        }
      }
    }

    void this.enqueue(() =>
      appendEntry(
        this.sessionId,
        {
          type: "message",
          message: persistMessage,
          timestamp: Date.now(),
          ...(options?.internal ? { internal: true } : {}),
          ...(options?.displayContent !== undefined
            ? { displayContent: options.displayContent }
            : {}),
          ...(options?.source !== undefined ? { source: options.source } : {}),
        },
        { baseDir: this.baseDir },
      ),
    );
  }

  /** Check whether compaction would trigger for the given messages (without executing it) */
  needsCompaction(messages: AgentMessage[]): boolean {
    const estimation = estimateTokenUsage({
      messages,
      systemPrompt: this.systemPrompt,
      contextWindowTokens: this.contextWindowTokens,
      reserveTokens: this.reserveTokens,
    });
    return shouldCompactTokens(estimation);
  }

  async maybeCompact(messages: AgentMessage[]): Promise<CompactionResult | null> {
    let workingMessages = messages;
    let toolResultPruningApplied = false;
    let pruningStats: { softTrimmed: number; hardCleared: number; charsSaved: number } | undefined;

    // Capture pre-pruning token count for accurate combined metrics
    const preCompactionTokens = estimateMessagesTokens(messages);

    // Phase 1: Tool result pruning (soft trim / hard clear)
    // This reduces token usage without removing messages
    if (this.enableToolResultPruning) {
      const pruneResult = pruneToolResults({
        messages: workingMessages,
        contextWindowTokens: this.contextWindowTokens,
        ...(this.toolResultPruning !== undefined ? { settings: this.toolResultPruning } : {}),
      });

      if (pruneResult.changed) {
        workingMessages = pruneResult.messages;
        toolResultPruningApplied = true;
        pruningStats = {
          softTrimmed: pruneResult.softTrimmed,
          hardCleared: pruneResult.hardCleared,
          charsSaved: pruneResult.charsSaved,
        };

        const postPruningTokens = estimateMessagesTokens(workingMessages);

        // Log pruning stats
        if (pruneResult.softTrimmed > 0 || pruneResult.hardCleared > 0) {
          console.error(
            `[SessionManager] Tool result pruning: ${pruneResult.softTrimmed} soft-trimmed, ` +
              `${pruneResult.hardCleared} hard-cleared, ~${Math.round(pruneResult.charsSaved / 1000)}k chars saved`,
          );
        }
        this.runLog.log("tool_result_pruning", {
          soft_trimmed: pruneResult.softTrimmed,
          hard_cleared: pruneResult.hardCleared,
          chars_saved: pruneResult.charsSaved,
          tokens_before: preCompactionTokens,
          tokens_after: postPruningTokens,
          phase: "compaction",
        });
      }
    }

    // Phase 2: Message compaction (remove old messages if still needed)
    let result: CompactionResult | null = null;

    if (this.compactionMode === "summary") {
      // Use provided model/apiKey or fall back to Kimi
      const model = this.model ?? getSummaryModel();
      const apiKey = this.apiKey ?? getSummaryApiKey();

      if (!apiKey) {
        // No API key available, downgrade to tokens mode
        result = compactMessages(workingMessages, {
          mode: "tokens",
          contextWindowTokens: this.contextWindowTokens,
          systemPrompt: this.systemPrompt,
          reserveTokens: this.reserveTokens,
          targetRatio: this.targetRatio,
          minKeepMessages: this.minKeepMessages,
        });
      } else {
        try {
          result = await compactMessagesAsync(workingMessages, {
            mode: "summary",
            model,
            apiKey,
            contextWindowTokens: this.contextWindowTokens,
            systemPrompt: this.systemPrompt,
            reserveTokens: this.reserveTokens,
            targetRatio: this.targetRatio,
            minKeepMessages: this.minKeepMessages,
            customInstructions: this.customInstructions,
            previousSummary: this.previousSummary,
          });

          // Save summary for next incremental update
          if (result?.summary) {
            this.previousSummary = result.summary;
          }
        } catch (err) {
          // Summary compaction failed entirely — fall back to tokens mode
          console.error(
            `[SessionManager] Summary compaction failed, falling back to tokens mode: ${err}`,
          );
          result = compactMessages(workingMessages, {
            mode: "tokens",
            contextWindowTokens: this.contextWindowTokens,
            systemPrompt: this.systemPrompt,
            reserveTokens: this.reserveTokens,
            targetRatio: this.targetRatio,
            minKeepMessages: this.minKeepMessages,
          });
        }
      }
    } else {
      // tokens mode
      result = compactMessages(workingMessages, {
        mode: "tokens",
        contextWindowTokens: this.contextWindowTokens,
        systemPrompt: this.systemPrompt,
        reserveTokens: this.reserveTokens,
        targetRatio: this.targetRatio,
        minKeepMessages: this.minKeepMessages,
      });
    }

    // If no message compaction needed but tool result pruning was applied,
    // still return the pruned messages
    if (!result) {
      if (toolResultPruningApplied) {
        const postPruningTokens = estimateMessagesTokens(workingMessages);
        return {
          kept: workingMessages,
          removedCount: 0,
          tokensRemoved: preCompactionTokens - postPruningTokens,
          tokensKept: postPruningTokens,
          reason: "pruning" as const,
          pruningStats,
        };
      }
      return null;
    }

    // Override metrics with accurate combined savings (Phase 1 + Phase 2)
    const postCompactionTokens = estimateMessagesTokens(result.kept);
    result.tokensRemoved = preCompactionTokens - postCompactionTokens;
    result.tokensKept = postCompactionTokens;
    result.pruningStats = pruningStats;

    this.runLog.log("compaction_detail", {
      pre_pruning_tokens: preCompactionTokens,
      post_compaction_tokens: postCompactionTokens,
      messages_removed: result.removedCount,
      reason: result.reason,
      pruning_applied: toolResultPruningApplied,
    });

    const entries: SessionEntry[] = [];
    if (this.meta) {
      entries.push({ type: "meta", meta: this.meta, timestamp: Date.now() });
    }
    for (const message of result.kept) {
      entries.push({ type: "message", message, timestamp: Date.now() });
    }
    entries.push({
      type: "compaction",
      removed: result.removedCount,
      kept: result.kept.length,
      timestamp: Date.now(),
      // Additional information in Token/Summary mode
      tokensRemoved: result.tokensRemoved,
      tokensKept: result.tokensKept,
      summary: result.summary,
      reason: result.reason,
    });

    await this.enqueue(() =>
      writeEntries(this.sessionId, entries, { baseDir: this.baseDir }),
    );
    return result;
  }

  /**
   * Wait for all pending storage writes to complete.
   */
  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task, task).catch((err) => {
      // Log for debuggability, but preserve failure for awaiters.
      console.error("[SessionManager] storage write failed:", err);
      throw err;
    });
    return this.queue;
  }
}
