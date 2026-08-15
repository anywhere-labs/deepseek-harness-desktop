# Agent Note: Users can delete sessions

Status: implemented

English | [中文](2026-08-15-session-deletion.zh.md)

## Problem

The session list had no delete action: `archive` only hides a row and keeps the log, and deleting a workspace leaves its sessions ungrouped. A user who wanted a session (or the leftover throwaway polish sessions an earlier polish implementation persisted) gone for good had no way — the persistence backend had no removal API, the agent registry had no public per-session teardown, and the row menu stopped at Rename/Fork/Archive.

## Decision

**Session deletion is a full lifecycle removal across host and client.** A new `session.delete` unary RPC stops the live agent (when attached), removes the in-memory session, and durably deletes the persisted log:

- **Persistence**: `SessionPersistence.remove(id)` is a new abstract method; the coordinator implements it (refuses a live or prepared identity, adopts and validates the stored prefix, then deletes through the backend) and each backend gains a `removeStored` hook — JSONL removes the session directory (POSIX directory fsync; skipped on Windows), SQLite deletes the events and session rows in one transaction.
- **Agent teardown**: `AgentLoop.disposeAgent(agent)` mirrors the rewind lifecycle half — flush the session's write-behind, then dispose the loop's tracked lifecycle (stop the machine, unregister, remove the session from the store, unwind the scope). A running agent is refused with `session-running`; the client cancels first.
- **API**: the RPC handler answers `session-not-found` when the session is neither attached nor persisted, `session-delete-failed` when teardown or removal fails, and otherwise returns `deleted: true`.
- **Client**: `ctx.sessions.deleteSession` calls the RPC and, on success, removes the row and instance state locally without waiting for a host frame (a cold deletion never emits one; a live deletion's `session/disposed` frame is a no-op by then). The workspace row menu gains a Delete item (danger-styled, with a confirmation dialog, mirroring workspace delete); workspace accounting keeps the stale id, which grouping surfaces filter out.

## Alternatives considered

- **Reuse workspace delete semantics** (unregister only, keep the log): rejected — the user asked for the session and its messages to be gone; archive already covers hide-but-keep.
- **Reuse the rollback truncate path**: rejected — truncation keeps a prefix; deletion removes the identity entirely.
- **Add a raw filesystem remove in the API layer**: rejected — removal must go through the coordinator so live/prepared identities are refused, write-behind drains, and both backends (JSONL and SQLite) remove atomically.

## Consequences

- A deleted session disappears from the list immediately (local removal) and from persistence (durable removal); reopening it reports not-found.
- Deleting a running session is refused with `session-running`; the user cancels first.
- Workspace `sessionIds` keep the deleted id; grouping surfaces filter it out, so no host-side accounting rewrite is needed.
- `AgentRegistry` stays owner-scoped: the new teardown lives on the loop (the structural provider), not on the registry.
