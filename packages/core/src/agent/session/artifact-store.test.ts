import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  saveToolResultArtifact,
  readToolResultArtifact,
  resolveArtifactsDir,
  resolveArtifactPath,
} from "./artifact-store.js";

describe("artifact-store", () => {
  const testDir = join(tmpdir(), `multica-artifact-test-${Date.now()}`);
  const sessionsDir = join(testDir, "sessions");
  const sessionId = "test-session-001";

  beforeEach(() => {
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("resolveArtifactsDir", () => {
    it("should resolve to artifacts subdirectory", () => {
      const dir = resolveArtifactsDir(sessionId, { baseDir: sessionsDir });
      expect(dir).toBe(join(sessionsDir, sessionId, "artifacts"));
    });
  });

  describe("resolveArtifactPath", () => {
    it("should resolve to a .txt file in the artifacts directory", () => {
      const path = resolveArtifactPath(sessionId, "toolu_abc123", { baseDir: sessionsDir });
      expect(path).toBe(join(sessionsDir, sessionId, "artifacts", "toolu_abc123.txt"));
    });

    it("should sanitize unsafe characters in toolCallId", () => {
      const path = resolveArtifactPath(sessionId, "tool/../../../etc", { baseDir: sessionsDir });
      expect(path).not.toContain("..");
      expect(path.endsWith(".txt")).toBe(true);
      expect(path).toContain("artifacts");
    });
  });

  describe("saveToolResultArtifact", () => {
    it("should save content to a file and return relative path", () => {
      const content = "Full stock data for 10 companies...";
      const relPath = saveToolResultArtifact(sessionId, "toolu_001", content, { baseDir: sessionsDir });

      expect(relPath).toBe("artifacts/toolu_001.txt");

      const filePath = join(sessionsDir, sessionId, relPath);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe(content);
    });

    it("should create artifacts directory if it does not exist", () => {
      const artifactsDir = resolveArtifactsDir(sessionId, { baseDir: sessionsDir });
      expect(existsSync(artifactsDir)).toBe(false);

      saveToolResultArtifact(sessionId, "toolu_002", "data", { baseDir: sessionsDir });
      expect(existsSync(artifactsDir)).toBe(true);
    });

    it("should handle multiple artifacts for the same session", () => {
      saveToolResultArtifact(sessionId, "toolu_001", "data1", { baseDir: sessionsDir });
      saveToolResultArtifact(sessionId, "toolu_002", "data2", { baseDir: sessionsDir });

      const data1 = readToolResultArtifact(sessionId, "toolu_001", { baseDir: sessionsDir });
      const data2 = readToolResultArtifact(sessionId, "toolu_002", { baseDir: sessionsDir });
      expect(data1).toBe("data1");
      expect(data2).toBe("data2");
    });

    it("should overwrite existing artifact with same toolCallId", () => {
      saveToolResultArtifact(sessionId, "toolu_001", "old data", { baseDir: sessionsDir });
      saveToolResultArtifact(sessionId, "toolu_001", "new data", { baseDir: sessionsDir });

      const data = readToolResultArtifact(sessionId, "toolu_001", { baseDir: sessionsDir });
      expect(data).toBe("new data");
    });
  });

  describe("readToolResultArtifact", () => {
    it("should return null for non-existent artifact", () => {
      const result = readToolResultArtifact(sessionId, "nonexistent", { baseDir: sessionsDir });
      expect(result).toBeNull();
    });

    it("should return content for existing artifact", () => {
      saveToolResultArtifact(sessionId, "toolu_read", "test content", { baseDir: sessionsDir });
      const result = readToolResultArtifact(sessionId, "toolu_read", { baseDir: sessionsDir });
      expect(result).toBe("test content");
    });

    it("should handle large content", () => {
      const largeContent = "x".repeat(500_000);
      saveToolResultArtifact(sessionId, "toolu_large", largeContent, { baseDir: sessionsDir });
      const result = readToolResultArtifact(sessionId, "toolu_large", { baseDir: sessionsDir });
      expect(result).toBe(largeContent);
    });
  });
});
