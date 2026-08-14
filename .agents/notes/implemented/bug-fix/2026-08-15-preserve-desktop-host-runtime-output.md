# Agent Note: Preserve desktop Host runtime output

Status: implemented

English | [中文](2026-08-15-preserve-desktop-host-runtime-output.zh.md)

## Problem

The desktop supervisor recognizes the loopback URL from a canonical Host stdout line, then resolves startup. The same readiness cleanup also detached the stdout and stderr data subscriptions. Node readable streams remain flowing when their data listeners are removed, so every later Host chunk was discarded instead of reaching desktop diagnostics. Runtime warnings and failure details became invisible after startup, leaving only an eventual exit code and signal.

## Decision

The supervisor keeps both Host output subscriptions for the lifetime of their streams. Every stdout and stderr chunk reaches the configured diagnostic callback. The stdout handler consults the readiness parser only until startup settles, and readiness cleanup owns only the timeout. The bounded recent-output tail remains available for startup-failure messages.

## Alternatives considered

**Stop consuming output after readiness.** Rejected because the Host is a desktop-owned child process and its warnings and errors are the primary diagnostics for failures that occur after startup.

**Keep forwarding stdout through the readiness parser.** Rejected because a later log line that resembles a different readiness URL must not turn ordinary runtime output into a conflicting-startup failure or terminate an already-ready Host.

**Persist Host output to a dedicated log file.** Deferred because persistence requires retention, rotation, and privacy decisions. Preserving the existing diagnostic callback fixes the loss without adding a durable artifact.

## Consequences

Host output remains observable through the desktop process for the entire run, while readiness still accepts exactly the first valid loopback URL. High-volume Host output reaches the existing diagnostic sink, but the supervisor's retained startup-failure context stays bounded. Unit coverage pins stdout and stderr forwarding after readiness and proves that later readiness-shaped output is logged without being parsed again.
