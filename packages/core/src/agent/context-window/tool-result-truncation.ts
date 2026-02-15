/**
 * Pre-emptive Tool Result Truncation
 *
 * Truncates oversized tool results BEFORE they are persisted to the session file.
 * The original full content is saved as an artifact so the agent can re-read it.
 *
 * This differs from tool-result-pruning.ts which operates AFTER persistence
 * during post-turn compaction. Pre-emptive truncation ensures:
 * 1. Session files don't grow unbounded
 * 2. Truncation markers tell the LLM where to find the full data
 * 3. The agent can use the read tool to access full artifacts when needed
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ─── Settings ─────────────────────────────────────────────────────────────────

export type ToolResultTruncationSettings = {
  /** Max fraction of context window a single tool result may occupy (default: 0.3) */
  maxResultContextShare: number;
  /** Absolute hard cap in characters (default: 400_000) */
  hardMaxResultChars: number;
  /** Minimum characters to always keep (default: 2_000) */
  minKeepChars: number;
  /** Fraction of budget allocated to head (default: 0.7) */
  headRatio: number;
  /** Fraction of budget allocated to tail (default: 0.2) */
  tailRatio: number;
};

export const DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS: ToolResultTruncationSettings = {
  maxResultContextShare: 0.3,
  hardMaxResultChars: 400_000,
  minKeepChars: 2_000,
  headRatio: 0.7,
  tailRatio: 0.2,
};

const CHARS_PER_TOKEN = 4;

// ─── Types ────────────────────────────────────────────────────────────────────

export type TruncatedToolResult = {
  toolCallId: string;
  toolName: string;
  originalChars: number;
  artifactRelPath: string;
};

export type TruncationResult = {
  /** The (possibly modified) message */
  message: AgentMessage;
  /** Whether any truncation was applied */
  truncated: boolean;
  /** Info about each truncated tool result */
  artifacts: TruncatedToolResult[];
};

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Compute the max chars allowed for a single tool result.
 */
function computeMaxChars(
  contextWindowTokens: number,
  settings: ToolResultTruncationSettings,
): number {
  const contextShare = contextWindowTokens * CHARS_PER_TOKEN * settings.maxResultContextShare;
  return Math.min(contextShare, settings.hardMaxResultChars);
}

/**
 * Extract text content from a tool result content field.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Truncate a text string, keeping head and tail portions.
 */
function truncateText(
  text: string,
  maxChars: number,
  artifactRelPath: string,
  settings: ToolResultTruncationSettings,
): string {
  const keepChars = Math.max(settings.minKeepChars, maxChars);
  if (text.length <= keepChars) return text;

  const headChars = Math.floor(keepChars * settings.headRatio);
  const tailChars = Math.floor(keepChars * settings.tailRatio);

  // Try to break at a newline boundary for the head
  let headEnd = headChars;
  const lastNewline = text.lastIndexOf("\n", headChars);
  if (lastNewline > headChars * 0.8) {
    headEnd = lastNewline;
  }

  const head = text.slice(0, headEnd);
  const tail = text.slice(text.length - tailChars);

  const marker =
    `\n\n[Tool result truncated: original ${text.length} chars. ` +
    `Full result saved to ${artifactRelPath}. ` +
    `Use the read tool to access the complete data if needed.]\n\n`;

  return head + marker + tail;
}

/**
 * Check if a content block contains images (skip those).
 */
function hasImages(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (b: any) => b && typeof b === "object" && b.type === "image",
  );
}

/**
 * Process a single user message. Detects oversized tool results and returns
 * truncation info. Does NOT save artifacts — the caller is responsible for that.
 *
 * @param saveArtifact - callback to save the original content and get the relative path
 */
export function truncateOversizedToolResults(params: {
  message: AgentMessage;
  contextWindowTokens: number;
  settings?: Partial<ToolResultTruncationSettings>;
  /** Called to save original content. Must return the relative artifact path. */
  saveArtifact: (toolCallId: string, content: string) => string;
}): TruncationResult {
  const settings: ToolResultTruncationSettings = {
    ...DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
    ...params.settings,
  };

  const msgAny = params.message as any;

  // Only process user messages with array content (tool results come as user messages)
  if (params.message.role !== "user" || !Array.isArray(msgAny.content)) {
    return { message: params.message, truncated: false, artifacts: [] };
  }

  const maxChars = computeMaxChars(params.contextWindowTokens, settings);
  let changed = false;
  const artifacts: TruncatedToolResult[] = [];
  const newContent: any[] = [];

  for (const block of msgAny.content) {
    if (!block || typeof block !== "object" || block.type !== "tool_result") {
      newContent.push(block);
      continue;
    }

    // Skip image-containing results
    if (hasImages(block.content)) {
      newContent.push(block);
      continue;
    }

    const text = extractText(block.content);

    // Check if oversized (respect minKeepChars floor)
    const effectiveMax = Math.max(maxChars, settings.minKeepChars);
    if (text.length <= effectiveMax) {
      newContent.push(block);
      continue;
    }

    const toolCallId = block.tool_use_id ?? "unknown";
    const toolName = block.name ?? "unknown";

    // Save original as artifact
    const artifactRelPath = params.saveArtifact(toolCallId, text);

    // Truncate the text
    const truncatedText = truncateText(text, maxChars, artifactRelPath, settings);

    newContent.push({
      ...block,
      content: [{ type: "text", text: truncatedText }],
    });

    artifacts.push({
      toolCallId,
      toolName,
      originalChars: text.length,
      artifactRelPath,
    });
    changed = true;
  }

  if (!changed) {
    return { message: params.message, truncated: false, artifacts: [] };
  }

  return {
    message: { ...params.message, content: newContent } as AgentMessage,
    truncated: true,
    artifacts,
  };
}
