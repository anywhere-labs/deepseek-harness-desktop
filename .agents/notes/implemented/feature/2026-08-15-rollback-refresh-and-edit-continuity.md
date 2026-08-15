# Agent Note: Rollback cleans the visible conversation; the edit fold survives continuation

Status: implemented

English | [中文](2026-08-15-rollback-refresh-and-edit-continuity.zh.md)

## Problem

Two user-visible gaps after a session mutation. First, **rollback did not clean the visible context and text**: a live rewind removes the session and re-adds it under the truncated log, but the client's resident Session instance stayed flagged `removed` (input disabled) with its stale pre-rewind window — the dropped messages stayed on screen and the session looked unusable. Cold sessions were worse: rollback required a live agent and answered `session-not-found`, so a reopened session could not be rolled back at all. Second, **editing then continuing** needed verification: the message-edit fold and the next turn must coexist on the real Session (the fold updates the SAME node, the next user message appends a second node, and the session stays usable).

## Decision

**Rollback refreshes the resident window and supports cold sessions.**

- **Client reset**: `Session.resetConversationWindow()` clears the `removed` flag, the event window, and the open state, then refetches history through the shared `resync` path. The manager calls it on `host/session-added` when the resident instance is `removed` (the rewind re-add); `ui-rollback` calls it after any successful rollback so the view refreshes even before the host frames land.
- **Cold rollback**: `RollbackService.rollback` no longer requires a live agent. A cold persisted session is loaded, the cut seq resolved from the log, the dropped span's file diffs reverse-applied (same code-revert path), and `persistence.truncate` cuts the durable log directly. The session stays cold — the next prompt resumes it with the full composition (preset + selection), unlike a bare loop resume which would leave it tool-less.
- **Edit continuity**: verified on the real Session with the real message Definition — the replacement folds into the same node by message id, a second edit keeps folding, and the next turn appends a new node with the session remaining usable (`removed` false, composer active). The client-built fold event now uses the trimmed text to match the host.

## Alternatives considered

- **Resume a bare agent for cold rollback**: rejected — the resume would lack the preset composition (tools, selection), and the api-proxy would return that agent as-is on the next prompt, stranding the session tool-less. Truncate-and-stay-cold lets the normal prompt path compose it properly.
- **Keep the rewind-frames as the only refresh**: rejected — cold rollback emits no frames at all, and the direct reset also makes the live case robust against frame delay.

## Consequences

- A rollback now visibly removes the dropped messages (context and text) and re-enables input; the client window refetches the truncated log.
- Cold sessions can be rolled back from the same button; the session remains cold until the next send.
- The edit fold is proven to survive continuation (repeated edits and subsequent turns) at the real Session level; the trimmed fold text matches the host surface.
