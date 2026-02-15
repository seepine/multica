/**
 * Artifact Store
 *
 * Preserves full tool result data when results are truncated for context window
 * management. Stored alongside session data so the agent can re-read them.
 *
 * Directory layout:
 *   ~/.super-multica/sessions/{sessionId}/artifacts/{toolCallId}.txt
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolveSessionDir, type SessionStorageOptions } from "./storage.js";

export function resolveArtifactsDir(
  sessionId: string,
  options?: SessionStorageOptions,
): string {
  return join(resolveSessionDir(sessionId, options), "artifacts");
}

function ensureArtifactsDir(
  sessionId: string,
  options?: SessionStorageOptions,
): void {
  const dir = resolveArtifactsDir(sessionId, options);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(dir, { recursive: true });
    } else {
      throw err;
    }
  }
}

/**
 * Save tool result content as an artifact.
 *
 * @returns The relative path from session directory (e.g. "artifacts/{toolCallId}.txt")
 */
export function saveToolResultArtifact(
  sessionId: string,
  toolCallId: string,
  content: string,
  options?: SessionStorageOptions,
): string {
  ensureArtifactsDir(sessionId, options);
  // Sanitize toolCallId for filesystem safety
  const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeId}.txt`;
  const filePath = join(resolveArtifactsDir(sessionId, options), fileName);
  writeFileSync(filePath, content, "utf8");
  return `artifacts/${fileName}`;
}

/**
 * Read a tool result artifact by toolCallId.
 *
 * @returns The full content, or null if not found.
 */
export function readToolResultArtifact(
  sessionId: string,
  toolCallId: string,
  options?: SessionStorageOptions,
): string | null {
  const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(
    resolveArtifactsDir(sessionId, options),
    `${safeId}.txt`,
  );
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}

/**
 * Resolve the absolute path for an artifact.
 */
export function resolveArtifactPath(
  sessionId: string,
  toolCallId: string,
  options?: SessionStorageOptions,
): string {
  const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(resolveArtifactsDir(sessionId, options), `${safeId}.txt`);
}
