# Agent-Driven E2E Testing Guide

This guide teaches Coding Agents (Claude Code, etc.) how to perform automated end-to-end testing of Super Multica features. Unlike traditional test frameworks, **the Coding Agent itself is the test runner and oracle** — it executes the agent, reads structured logs, and intelligently analyzes the results.

## Overview

The testing flow:

1. Coding Agent runs `pnpm multica run --run-log "test prompt"`
2. The agent engine executes the prompt with full structured logging
3. Coding Agent reads the `run-log.jsonl` and `session.jsonl` files
4. Coding Agent analyzes events, tool calls, and behavior for correctness

This approach is superior to static assertions because:
- The AI can understand **intent** — did the agent do what the prompt asked?
- It can reason about **intermediate process** — were the right tools called in the right order?
- It can detect **subtle issues** — token counts that don't make sense, unnecessary retries, missing events

## Prerequisites

1. **Credentials configured**: Run `pnpm multica credentials init` or ensure `~/.super-multica/credentials.json5` has valid provider credentials
2. **Available providers**: Check with `pnpm multica profile list` or inspect credentials file
3. **Default provider**: `kimi-coding` (Kimi Code, free tier available). Can override with `--provider`
4. **`MULTICA_API_URL`**: Required for `web_search` and `data` tools. Set to `https://api-dev.copilothub.ai` for dev environment. Without this, web search and financial data tools will fail with `MULTICA_API_URL is required`

## Running a Test

### Basic command

```bash
# For prompts that only need exec/read/write tools:
pnpm multica run --run-log "your test prompt here"

# For prompts that need web_search or data tools (requires API URL):
MULTICA_API_URL=https://api-dev.copilothub.ai pnpm multica run --run-log "your test prompt here"
```

### With provider override

```bash
MULTICA_API_URL=https://api-dev.copilothub.ai pnpm multica run --run-log --provider claude-code "your test prompt"
MULTICA_API_URL=https://api-dev.copilothub.ai pnpm multica run --run-log --provider kimi-coding "your test prompt"
MULTICA_API_URL=https://api-dev.copilothub.ai pnpm multica run --run-log --provider anthropic --api-key sk-ant-... "your test prompt"
```

### Resume a session (multi-turn testing)

```bash
# First turn
MULTICA_API_URL=https://api-dev.copilothub.ai pnpm multica run --run-log "Create a file called test.txt with content 'hello'"
# Note the session ID from stderr output: [session: 019c584a-...]

# Second turn (same session)
MULTICA_API_URL=https://api-dev.copilothub.ai pnpm multica run --run-log --session 019c584a-... "Read the file test.txt and tell me its content"
```

### Output

The CLI prints metadata to stderr:
```
[session: 019c584a-7753-762d-9fb9-9eb0a8187df5]
[session-dir: /Users/you/.super-multica/sessions/019c584a-7753-762d-9fb9-9eb0a8187df5]
```

Agent text output goes to stdout.

## Reading Results

After a run, two files contain the data needed for analysis:

### run-log.jsonl

Location: `{session-dir}/run-log.jsonl`

Each line is a JSON object with structured event data. Read this file to understand **what happened during execution**.

```jsonl
{"ts":1739000001,"event":"run_start","prompt":"What is 2+2?","provider":"kimi-coding","model":"kimi-k2-thinking","messages":0}
{"ts":1739000002,"event":"llm_call","provider":"kimi-coding","model":"kimi-k2-thinking","messages":2}
{"ts":1739000005,"event":"llm_result","duration_ms":3000}
{"ts":1739000005,"event":"run_end","duration_ms":4000,"error":null,"text":"4"}
```

### session.jsonl

Location: `{session-dir}/session.jsonl`

Contains the full conversation transcript (user messages, assistant replies, tool calls and results). Read this for **message content analysis**.

## Run-Log Event Reference

> Source of truth: `packages/core/src/agent/run-log.ts` (JSDoc at top of file)

### Lifecycle Events

| Event | Fields | Description |
|-------|--------|-------------|
| `run_start` | prompt, internal, provider, model, messages | Agent run begins |
| `run_end` | duration_ms, error, text, aborted? | Agent run completes |

### LLM Interaction

| Event | Fields | Description |
|-------|--------|-------------|
| `llm_call` | provider, model, profile, messages | LLM API request sent |
| `llm_result` | duration_ms | LLM API response received |

### Tool Execution

| Event | Fields | Description |
|-------|--------|-------------|
| `tool_start` | tool, args | Tool execution begins |
| `tool_end` | tool, duration_ms, is_error | Tool execution completes |

### Context Management

| Event | Fields | Description |
|-------|--------|-------------|
| `preflight_compact_start` | utilization, trigger, messages, est_tokens | Preflight compaction triggered |
| `preflight_compact_end` | messages_before, messages_after, pruned | Preflight compaction done |
| `tool_result_pruning` | soft_trimmed, hard_cleared, chars_saved, phase, tokens_before?, tokens_after? | Tool result pruning (Phase 1) |
| `compaction` | removed, kept, tokens_removed, tokens_kept, reason, pruning_stats? | Summary compaction (Phase 2) |
| `compaction_detail` | pre_pruning_tokens, post_compaction_tokens, messages_removed, reason, pruning_applied | Detailed compaction breakdown |

### Error Recovery

| Event | Fields | Description |
|-------|--------|-------------|
| `context_overflow` | attempt, messages_before | Context window overflow detected |
| `context_overflow_compacted` | messages_after, tokens_removed | Recovered via compaction |
| `context_overflow_forced` | messages_before, messages_after | Recovered via forced drop |
| `error_classify` | error, reason, rotatable | Error classified for rotation |
| `auth_rotate` | from, to, reason | Auth profile rotated |

## Feature Test Playbooks

### 1. Basic Prompt Completion

**Goal**: Verify the agent can complete a simple prompt end-to-end.

```bash
pnpm multica run --run-log "What is the capital of France? Reply in one word."
```

**What to check in run-log**:
- `run_start` event exists with correct provider
- `llm_call` → `llm_result` pair exists (at least one)
- `run_end` event has `error: null`
- `run_end.duration_ms` is reasonable (< 30s for simple prompt)

**What to check in output**:
- Text contains "Paris"

### 2. Tool Usage

**Goal**: Verify tools are called correctly when the prompt requires them.

```bash
pnpm multica run --run-log --cwd /tmp "List the files in the current directory"
```

**What to check in run-log**:
- `tool_start` event with `tool: "exec"` or similar filesystem tool
- Matching `tool_end` with `is_error: false`
- Tool called before final `run_end`

**What to check in output**:
- Output contains actual file names from /tmp

### 3. Context Compaction

**Goal**: Verify compaction works correctly on long sessions.

```bash
# Build up a long session to trigger compaction
pnpm multica run --run-log "Write a detailed 2000-word essay about climate change"
# Note session ID, then continue:
pnpm multica run --run-log --session {id} "Now write another 2000-word essay about renewable energy"
pnpm multica run --run-log --session {id} "Summarize both essays in 3 bullet points"
```

**What to check in run-log**:
- `preflight_compact_start` appears when utilization exceeds trigger ratio
- `tool_result_pruning` shows `soft_trimmed > 0` or `hard_cleared > 0` if tool results were pruned
- `compaction` event has `tokens_removed > 0` (not near-zero like the bug we fixed)
- `compaction_detail` shows `pre_pruning_tokens` > `post_compaction_tokens`

### 4. Multi-Provider Comparison

**Goal**: Verify the same prompt works across different providers.

```bash
pnpm multica run --run-log --provider kimi-coding "Explain recursion in 2 sentences"
pnpm multica run --run-log --provider claude-code "Explain recursion in 2 sentences"
```

**What to check**:
- Both runs complete without errors
- Both `run_end` events have `error: null`
- Compare `llm_result.duration_ms` across providers
- Both outputs are meaningful explanations of recursion

### 5. Error Handling & Auth Rotation

**Goal**: Verify error recovery when credentials are invalid.

```bash
pnpm multica run --run-log --provider anthropic --api-key "sk-invalid-key" "Hello"
```

**What to check in run-log**:
- `error_classify` event with `reason: "auth"`
- `auth_rotate` event if multiple profiles are configured
- `run_end` with appropriate error message if no valid profiles exist

## Analysis Patterns

When analyzing run-logs, look for these patterns:

### Healthy Run
```
run_start → llm_call → llm_result → run_end (error: null)
```

### Run with Tool Usage
```
run_start → llm_call → llm_result → tool_start → tool_end → llm_call → llm_result → run_end
```

### Run with Compaction
```
run_start → preflight_compact_start → tool_result_pruning → preflight_compact_end → llm_call → ...
```

### Red Flags
- `run_end` without preceding `run_start` (log corruption)
- `tool_start` without matching `tool_end` (tool hang/crash)
- `compaction` with `tokens_removed` near zero (compaction ineffective)
- Multiple `error_classify` events (repeated failures)
- `context_overflow_forced` (emergency fallback — should be rare)

## Creating a New Test Playbook

When a new feature is implemented, create a test playbook following this template:

```markdown
### N. Feature Name

**Goal**: One sentence describing what to verify.

**Command**:
\`\`\`bash
pnpm multica run --run-log [options] "prompt that exercises the feature"
\`\`\`

**What to check in run-log**:
- List specific events and field values to verify
- Include both positive checks (event exists) and negative checks (no errors)

**What to check in output**:
- What the text output should contain or look like

**What to check in session.jsonl** (if applicable):
- Specific message patterns to verify
```

## Tips for Coding Agents

1. **Always use `--run-log`** — without it, there's no structured data to analyze
2. **Use `--cwd`** to control the working directory for file-related tests
3. **Read run-log line by line** — each line is independent JSON, parse individually
4. **Check event ordering** — events are chronologically ordered by `ts`
5. **Token counts are estimates** — don't expect exact values, check for reasonable ranges
6. **Clean up test sessions** — after testing, remove session dirs from `~/.super-multica/sessions/` to avoid clutter
7. **Use `--provider`** to test specific providers — defaults to whatever is configured in credentials
8. **For multi-turn tests**, always capture and reuse the session ID from the first run
