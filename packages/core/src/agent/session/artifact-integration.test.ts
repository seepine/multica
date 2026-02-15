/**
 * E2E Integration Test: Phase 1 — Artifact Storage + Pre-emptive Truncation
 *
 * Tests the full flow: SessionManager → truncateOversizedToolResults → artifact-store
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "./session-manager.js";
import { readEntries } from "./storage.js";
import { readToolResultArtifact } from "./artifact-store.js";

const makeTestDir = () => {
  const dir = join(tmpdir(), `multica-e2e-p1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Extract text from a tool_result content field, which can be:
 * - a string (original format)
 * - an array of { type: "text", text: "..." } (after truncation)
 */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
  }
  return "";
}

describe("Phase 1 E2E: Artifact Storage + Pre-emptive Truncation", () => {
  let testDir: string;
  const sessionId = "test-session-e2e";

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves oversized tool result to artifact and truncates in session", async () => {
    const sm = new SessionManager({
      sessionId,
      baseDir: testDir,
      compactionMode: "tokens",
      contextWindowTokens: 100_000,
      enableToolResultTruncation: true,
      enableToolResultPruning: false,
    });

    // Create an oversized tool result (> 30% of 100k * 4 chars = 120k chars)
    const bigContent = "X".repeat(200_000);
    const userMessage = {
      role: "user" as const,
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: "call_abc123",
          content: bigContent,
        },
      ],
      timestamp: Date.now(),
    };

    sm.saveMessage(userMessage);
    await sm.flush();

    // Verify: session file has truncated content
    const entries = readEntries(sessionId, { baseDir: testDir });
    const msgEntries = entries.filter((e) => e.type === "message");
    expect(msgEntries.length).toBe(1);

    const saved = (msgEntries[0] as any).message;
    const savedText = extractContentText(saved.content[0].content);
    expect(savedText.length).toBeLessThan(bigContent.length);
    expect(savedText).toContain("Tool result truncated");
    expect(savedText).toContain("artifacts/");

    // Verify: artifact file exists with full content
    const artifactContent = readToolResultArtifact(sessionId, "call_abc123", { baseDir: testDir });
    expect(artifactContent).toBe(bigContent);
  });

  it("does NOT create artifact for small tool results", async () => {
    const sm = new SessionManager({
      sessionId,
      baseDir: testDir,
      compactionMode: "tokens",
      contextWindowTokens: 200_000,
      enableToolResultTruncation: true,
      enableToolResultPruning: false,
    });

    const smallContent = "Small result data";
    const userMessage = {
      role: "user" as const,
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: "call_small",
          content: smallContent,
        },
      ],
      timestamp: Date.now(),
    };

    sm.saveMessage(userMessage);
    await sm.flush();

    // Verify: session file has full content (no truncation)
    const entries = readEntries(sessionId, { baseDir: testDir });
    const saved = (entries.find((e) => e.type === "message") as any).message;
    const savedText = extractContentText(saved.content[0].content);
    expect(savedText).toBe(smallContent);

    // Verify: no artifacts directory created
    const artifactsDir = join(testDir, "sessions", sessionId, "artifacts");
    expect(existsSync(artifactsDir)).toBe(false);
  });

  it("truncated message preserves head and tail of original content", async () => {
    const sm = new SessionManager({
      sessionId,
      baseDir: testDir,
      compactionMode: "tokens",
      contextWindowTokens: 50_000, // smaller window → lower threshold
      enableToolResultTruncation: true,
      enableToolResultPruning: false,
    });

    // Create content with identifiable head and tail
    const head = "HEAD_MARKER_" + "A".repeat(10_000);
    const middle = "B".repeat(100_000);
    const tail = "C".repeat(10_000) + "_TAIL_MARKER";
    const bigContent = head + middle + tail;

    const userMessage = {
      role: "user" as const,
      content: [
        {
          type: "tool_result" as const,
          tool_use_id: "call_headtail",
          content: bigContent,
        },
      ],
      timestamp: Date.now(),
    };

    sm.saveMessage(userMessage);
    await sm.flush();

    const entries = readEntries(sessionId, { baseDir: testDir });
    const saved = (entries.find((e) => e.type === "message") as any).message;
    const savedText = extractContentText(saved.content[0].content);

    // Head should be preserved
    expect(savedText).toContain("HEAD_MARKER_");
    // Tail should be preserved
    expect(savedText).toContain("_TAIL_MARKER");
    // Middle should be truncated
    expect(savedText.length).toBeLessThan(bigContent.length);
  });

  it("handles multiple tool results in same message", async () => {
    const sm = new SessionManager({
      sessionId,
      baseDir: testDir,
      compactionMode: "tokens",
      contextWindowTokens: 50_000,
      enableToolResultTruncation: true,
      enableToolResultPruning: false,
    });

    const bigContent1 = "RESULT1_" + "X".repeat(200_000);
    const smallContent = "small result";
    const bigContent2 = "RESULT2_" + "Y".repeat(200_000);

    const userMessage = {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, tool_use_id: "call_big1", content: bigContent1 },
        { type: "tool_result" as const, tool_use_id: "call_small", content: smallContent },
        { type: "tool_result" as const, tool_use_id: "call_big2", content: bigContent2 },
      ],
      timestamp: Date.now(),
    };

    sm.saveMessage(userMessage);
    await sm.flush();

    const entries = readEntries(sessionId, { baseDir: testDir });
    const saved = (entries.find((e) => e.type === "message") as any).message;

    // Big results should be truncated
    const text0 = extractContentText(saved.content[0].content);
    const text2 = extractContentText(saved.content[2].content);
    expect(text0).toContain("Tool result truncated");
    expect(text2).toContain("Tool result truncated");

    // Small result should be unchanged
    const text1 = extractContentText(saved.content[1].content);
    expect(text1).toBe(smallContent);

    // Both artifacts should exist
    const art1 = readToolResultArtifact(sessionId, "call_big1", { baseDir: testDir });
    expect(art1).toContain("RESULT1_");
    const art2 = readToolResultArtifact(sessionId, "call_big2", { baseDir: testDir });
    expect(art2).toContain("RESULT2_");
  });

  it("respects enableToolResultTruncation=false", async () => {
    const sm = new SessionManager({
      sessionId,
      baseDir: testDir,
      compactionMode: "tokens",
      contextWindowTokens: 50_000,
      enableToolResultTruncation: false, // Disabled
      enableToolResultPruning: false,
    });

    const bigContent = "Z".repeat(200_000);
    const userMessage = {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, tool_use_id: "call_noop", content: bigContent },
      ],
      timestamp: Date.now(),
    };

    sm.saveMessage(userMessage);
    await sm.flush();

    const entries = readEntries(sessionId, { baseDir: testDir });
    const saved = (entries.find((e) => e.type === "message") as any).message;
    // Should NOT be truncated since feature is disabled
    const savedText = extractContentText(saved.content[0].content);
    expect(savedText).toBe(bigContent);
  });
});
