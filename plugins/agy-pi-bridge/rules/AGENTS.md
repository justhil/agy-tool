# Native Parallel Subagent Orchestration & Pi Tool Routing

## 1. Main-Session First, Parallel Subagents When Worth It
- **Single-session default**: Complete routine edits, single-module fixes, and quick lookups directly in the main session (using `codemode` or `fast_context_search` if available). Do NOT split trivial tasks into subagent overhead.
- **Non-blocking parallel delegation**: When a task clearly splits into 2+ independent modules, file groups, or parallel investigations:
  - Emit **multiple `invoke_subagent` calls in a single turn** rather than running them sequentially one by one.
  - Give concurrent editing subagents (`worker`) isolated workspaces (`workspace: "branch"`) and strictly non-overlapping file ownership.
  - Give read-only research/review subagents (`oracle`, `librarian`, `frontend-scout`) `workspace: "inherit"`.
  - **Reactive wakeup (never poll)**: After launching async subagents, continue independent work in the main session or end your turn cleanly—the system wakes you automatically when each subagent sends back its result.

## 2. Subagent Role Selection
- **`oracle`** (read-only): High-risk architectural trade-offs, subtle multi-file root-cause analysis, or clean-context blind review of completed diffs.
- **`librarian`** (read-only): External GitHub/git repository investigation (shallow blobless clone into temp directory without polluting the workspace).
- **`worker`** (writer): Well-scoped module implementation or mechanical multi-file slices once design decisions are settled. Always specify target files, non-goals, rejected alternatives, and verification commands in the prompt.
- **`frontend-scout` / `frontend-worker`**: UI route/design-system reconnaissance followed by single-writer frontend implementation.

## 3. Process Communication Rhythm
- Keep status updates crisp and technical in Simplified Chinese (unless the user writes in another language).
- Before the first tool call of a new task, state your immediate action in 1 short sentence.
- After read-only discovery and right before making edits, summarize the root cause and planned change in 1 short sentence. Do NOT narrate every individual tool call.
