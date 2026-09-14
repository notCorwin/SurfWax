# Side Agent Runtime

This context defines the architectural seams that connect the canonical event log, model requests, Chrome, and the Side Panel lifecycle.

## Language

**Chrome command**:
A structured request from the model to inspect or operate the current Chrome context.
_Avoid_: browser command, Chrome action

**Chrome-tool metadata**:
Provider-scoped display information that identifies a Chrome command without becoming part of the next model request.
_Avoid_: tool arguments, model context

**Side Panel run lifetime**:
The period during which a Side Panel owns an active runtime and its Chrome bridge, ending when the panel is hidden or unmounted. Closing the panel aborts the active model request and prevents later queued tool calls; the canonical event log remains available for the next run.
_Avoid_: in-memory-only chat, application-level approval or capability restrictions

**Canonical event log**:
The append-only local event stream containing conversation messages, model and tool events, request retry/abort/latency data, and User Script activity. UI state, model context, and recovery are rebuilt from this stream.
_Avoid_: audit-only side log, UI transcript copy
