import { describe, it, expect, beforeEach } from "vitest";
import {
  truncateOversizedToolResults,
  DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS,
} from "./tool-result-truncation.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

describe("tool-result-truncation", () => {
  describe("DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS", () => {
    it("should have expected defaults", () => {
      expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.maxResultContextShare).toBe(0.3);
      expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.hardMaxResultChars).toBe(400_000);
      expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.minKeepChars).toBe(2_000);
      expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.headRatio).toBe(0.7);
      expect(DEFAULT_TOOL_RESULT_TRUNCATION_SETTINGS.tailRatio).toBe(0.2);
    });
  });

  describe("truncateOversizedToolResults", () => {
    // Helper to create artifact paths
    const savedArtifacts: Array<{ toolCallId: string; content: string }> = [];
    const mockSaveArtifact = (toolCallId: string, content: string) => {
      savedArtifacts.push({ toolCallId, content });
      return `artifacts/${toolCallId}.txt`;
    };

    beforeEach(() => {
      savedArtifacts.length = 0;
    });

    it("should not truncate assistant messages", () => {
      const message = {
        role: "assistant",
        content: "x".repeat(500_000),
      } as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(false);
      expect(result.artifacts).toHaveLength(0);
      expect(savedArtifacts).toHaveLength(0);
    });

    it("should not truncate plain user text messages", () => {
      const message = {
        role: "user",
        content: "Hello, world!",
      } as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(false);
    });

    it("should not truncate small tool results", () => {
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_001",
            name: "read",
            content: [{ type: "text", text: "small result" }],
          },
        ],
      } as unknown as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(false);
      expect(savedArtifacts).toHaveLength(0);
    });

    it("should truncate oversized tool results", () => {
      // 100k tokens * 4 chars/token * 0.3 share = 120,000 char max
      const largeContent = "x".repeat(200_000);
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_large",
            name: "exec",
            content: [{ type: "text", text: largeContent }],
          },
        ],
      } as unknown as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]!.toolCallId).toBe("toolu_large");
      expect(result.artifacts[0]!.toolName).toBe("exec");
      expect(result.artifacts[0]!.originalChars).toBe(200_000);
      expect(result.artifacts[0]!.artifactRelPath).toBe("artifacts/toolu_large.txt");

      // Verify artifact was saved
      expect(savedArtifacts).toHaveLength(1);
      expect(savedArtifacts[0]!.content).toBe(largeContent);

      // Verify the truncated message is smaller
      const truncatedBlock = (result.message as any).content[0];
      const truncatedText = truncatedBlock.content[0].text;
      expect(truncatedText.length).toBeLessThan(200_000);
      expect(truncatedText).toContain("[Tool result truncated:");
      expect(truncatedText).toContain("artifacts/toolu_large.txt");
      expect(truncatedText).toContain("read tool");
    });

    it("should skip image-containing tool results", () => {
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_img",
            name: "browser",
            content: [
              { type: "text", text: "x".repeat(500_000) },
              { type: "image", data: "base64data..." },
            ],
          },
        ],
      } as unknown as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(false);
    });

    it("should respect hardMaxResultChars", () => {
      // Set a very generous context share but strict hard max
      const largeContent = "x".repeat(10_000);
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_hard",
            name: "exec",
            content: [{ type: "text", text: largeContent }],
          },
        ],
      } as unknown as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 1_000_000, // very large context
        settings: { hardMaxResultChars: 5_000 },
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(true);
    });

    it("should handle multiple tool results in one message", () => {
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_small",
            name: "read",
            content: [{ type: "text", text: "small" }],
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_big",
            name: "exec",
            content: [{ type: "text", text: "y".repeat(200_000) }],
          },
          {
            type: "text",
            text: "some user text",
          },
        ],
      } as unknown as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]!.toolCallId).toBe("toolu_big");

      // Non-tool-result blocks preserved unchanged
      const blocks = (result.message as any).content;
      expect(blocks[0].content[0].text).toBe("small"); // small tool result unchanged
      expect(blocks[2].text).toBe("some user text"); // text block unchanged
    });

    it("should handle string content in tool results", () => {
      const largeContent = "z".repeat(200_000);
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_str",
            name: "exec",
            content: largeContent,
          },
        ],
      } as unknown as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(true);
      expect(savedArtifacts[0]!.content).toBe(largeContent);
    });

    it("should preserve head and tail of truncated content", () => {
      // Create content with identifiable head and tail
      const head = "HEAD_" + "a".repeat(50_000);
      const middle = "b".repeat(100_000);
      const tail = "c".repeat(50_000) + "_TAIL";
      const content = head + middle + tail;

      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_headtail",
            name: "exec",
            content: [{ type: "text", text: content }],
          },
        ],
      } as unknown as AgentMessage;

      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100_000, // 120k char max
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(true);
      const truncatedText = (result.message as any).content[0].content[0].text;
      expect(truncatedText).toContain("HEAD_");
      expect(truncatedText).toContain("_TAIL");
    });

    it("should use custom settings", () => {
      const content = "x".repeat(5_000);
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_custom",
            name: "exec",
            content: [{ type: "text", text: content }],
          },
        ],
      } as unknown as AgentMessage;

      // Small context with tight settings should trigger truncation
      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 1_000, // 1000 tokens * 4 * 0.3 = 1200 char max
        settings: { minKeepChars: 500 },
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(true);
    });

    it("should not truncate when content fits within minKeepChars", () => {
      const content = "x".repeat(1_500);
      const message = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_min",
            name: "exec",
            content: [{ type: "text", text: content }],
          },
        ],
      } as unknown as AgentMessage;

      // Even with very small context, minKeepChars (2000) > content (1500)
      const result = truncateOversizedToolResults({
        message,
        contextWindowTokens: 100,
        saveArtifact: mockSaveArtifact,
      });

      expect(result.truncated).toBe(false);
    });
  });
});
