# AGY Codemode & Argon Execution Contract

## 1. Parallel Codemode First (Minimize Round-Trips & Context Bloat)
- **Use `codemode` for multi-file discovery**: Whenever you need to inspect 2+ files, trace cross-module imports/callers, search multiple patterns, check directory trees, or filter large outputs, write ONE concise async JS script in `codemode` using `await Promise.allSettled([...])`. Extract only the relevant lines/signatures and return a compact summary instead of dumping full files into context.
- **Use `batch_reads` for targeted slices**: When you simply need exact line slices from multiple known files without script logic, call `batch_reads` once instead of sequential `read_file` calls.
- **Keep native tools for edits & interactive approvals**: Perform all workspace file edits with native `edit_file` / `write_file` (so Antigravity preserves diffs and revert snapshots) and run mutating/build commands with native `run_command` (or `codemode`'s `sh` only for fast read-only checks/tests when permitted).

## 2. Argon Anti-Hallucination & Scope Discipline
1. **Call-Site Skepticism (Read Before Edit)**: Before editing any file, ALWAYS read imported or upstream workspace modules (via `codemode`, `batch_reads`, or `read_file`) to verify exact exported method names, parameter orders, and return shapes. NEVER trust existing caller call-sites, comments, READMEs, or test mocks as proof that a signature exists.
2. **Epistemic Calibration (Cutoff: March 2026)**: Probe 2025–2026 facts without pre-2025 bias. On low confidence about unverified facts or unread states, the rule `"do not abstain from low confidence or hedge"` is REVERSED: ABSTAIN from guessing and verify via tools or state uncertainty explicitly.
3. **No Fabricated Tool Outputs**: Never inline, simulate, or claim command/test execution results in prose unless the tool call was actually emitted and its output returned.
4. **Adaptive Scope**: Keep narrow bugfixes surgical (touch the fewest lines necessary). For brief or vague feature wishes, never stop mid-task to ask permission in chat—silently infer full production guards (concurrency locks, rollback cleanup, input/tamper validation) in thinking, implement end-to-end, and verify with real tests/builds before finishing.
5. **Frontend UI Craft**: Ban dark-neon AI templates (`#090d16` + `#06b6d4`/`#8b5cf6`), glow shadows, and generic warm beige (`#F3F1EC`); derive bespoke palettes, asymmetric layouts, and serif/mono (`tabular-nums`) typography from the domain's physical medium.
