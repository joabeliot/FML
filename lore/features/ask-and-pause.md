# Asking a person mid-run (FML-26)

A run can stop for human input: `ask.<name>: <prompt>` asks for a value,
`pause: <message>` waits for a go-ahead. The user-facing description is in
HOW-TO.md, under "Stopping for a person".

## Design

- **Injected, like Transport and UiDriver.** `RunOptions.ask: AskHandler`
  takes `(AskRequest, signal)` and returns the answer, `""` for a pause, or
  `null` to cancel.
  - The app's handler is a modal (`AskDialog`, held open by `useFlowRun`).
  - The CLI's handler is a readline prompt on stderr.
  - The engine never knows which one it's talking to.
- **Before the node acts,** after `onStepStart`: the pause first, then each
  `ask.*` in source order. A value already in the store is not asked, so the
  same flow runs in CI with `--var`.
- **No handler** means the step fails with `failedOn: "ask"` and a message
  pointing at `--var` / `--yes`, and the walk ends like a failed request.
  Hanging forever in CI would be worse.
- **Cancel** gives the new `StopReason` `"cancelled"`, with
  `RunResult.cancelledAt`. The run is not ok, and the report failure kind is
  `cancelled`.
- **Abort while waiting** (the app's Stop button) throws through, which is
  the same as an abort mid-request.
- **Never record answers.** `StepResult.asked` holds kind, name and how long
  it waited. Secret-looking names (`looksSecret`) get masked input, and the
  CLI adds the answers to the redaction set.
- **For tooling, an `ask.<name>` supplies `{name}` the way a capture does:**
  - variables.ts gives it source `ask`;
  - lint counts it as supplied;
  - `requiredInputs` skips it;
  - dataWires gives the asking node an output port wired to its spenders.
- `pause` is in `ANY_NODE_KEYS` (allowed on every type), and `ask` is in
  `EXEC_KEY_PREFIXES`.
