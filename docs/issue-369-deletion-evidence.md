# Issue 369: session deletion capability and transaction boundary

Status: recoverable logical deletion implemented. Physical data erasure is outside scope.

## Introduction

[Issue 369](https://github.com/anywhere-labs/dsh-desktop/issues/369) requests a missing Delete Session action in Desktop 2.0.1 on Windows 11. The reporter clarified that no delete action exists. A failure in an existing delete action is outside the report. Archive and Delete must retain distinct meanings: Archive keeps a session recoverable through the archive UI; Delete must retire its identity from ordinary session access and must not silently damage branch history.

This inspection uses Desktop commit `03dcfa1d915d0864798df888be8cf101196b4d30` and the exact vendored `0.2.1-alpha.2` runtime artifacts. The pinned source checkout remains unmodified. Historical [PR 51](https://github.com/anywhere-labs/dsh-desktop/pull/51) proposed deletion by modifying the upstream runtime tree; it is closed and does not establish a shipped capability in the current product. [PR 446](https://github.com/anywhere-labs/dsh-desktop/pull/446) adds access to existing session actions, including Archive, and is also closed.

## Source facts

- `@deepseek-ai/dsh-client-ui-workspace` exposes `sidebar.workspaces.session.menu.item`. A Desktop-owned client can register one menu button with the existing keyboard navigation and menu dismissal. The shipped actions are Pin, Rename, Fork, and Archive; there is no Delete action.
- `@deepseek-ai/dsh-session-persistence` exposes `create`, `open`, `flush`, `stat`, and `list`. It has no removal operation. `SessionHandle.close` drains acknowledged writes and releases write ownership.
- `@deepseek-ai/dsh-agent` defines `AgentHandle.dispose` as the owner capability that stops and drains the loop, unregisters the agent, removes its session from the store, and unwinds its scoped world. `AgentRegistry.get` returns a bare agent, deliberately without this authority.
- `@deepseek-ai/dsh-api-session-controller` drops the handle after `agents.create` and `agents.resume`, returning only `.agent`. It needs to retain its own handles before it can provide an owner-authorized deletion lifecycle. A foreign agent owner must be refused.
- `@deepseek-ai/dsh-workspace` supplies `archiveSession`, `unarchiveSession`, and an activity refusal/stop protocol. Archive preserves workspace accounting and stored session history. Relabeling this operation as Delete would misrepresent its behavior.
- `@deepseek-ai/dsh-session-persistence-jsonl` stores immutable format generations in each session directory. Its write lease uses a POSIX kernel lock on the stable `session.lock` inode or a Windows named semaphore. Removing the POSIX lock file forfeits exclusion and is forbidden by the lease contract.
- JSONL read handles do not acquire a write lease. New sessions can remain created but unmaterialized until their first append or flush. `list` includes local pending entries, but another process cannot discover them before materialization.
- Fork and subagent lineage uses the durable `parentSession` field. Known children must be checked before deletion; listing failures must propagate, rather than being interpreted as an empty history.

## Selected product behavior

Delete moves an inactive Session to Desktop's Deleted sessions collection. The exact Session is removed from ordinary/archived catalog views and content search. Prompt, model selection, rename, queue edits, new history opening and source forks are refused while it is deleted; independent branches retain their own histories. Settings provides Restore. The original workspace accounting, pins, Archive state, immutable generations and every write lease remain unchanged. The confirmation and settings text explicitly say that history remains on disk to protect branches.

Desktop stores one private, versioned JSON marker per hashed Session identity under the selected Home's `desktop-session-trash` directory. The existing `withFileLock` serializes writers across processes; `writeFileAtomic` replaces a complete record with private permission bits. Restore commits `deleted: false` rather than unlinking a marker. A private Home anchor and directory UUID bind the collection to its original root; missing, replaced or linked roots fail closed, including on a later Host startup. Membership reads consult the file every time, so another Host sees the committed admission state without an in-memory cache. A directory watcher pushes catalog removal/restoration events; list/search also recheck membership after asynchronous work. A failed watcher cannot reopen mutation admission.

The exact runtime patch adds no new wire methods or error codes. Existing `session/agent-busy` refusals explain how to restore. The patch contributes a capability marker on the Host controller. Desktop refuses mutations and disables the menu when that marker is absent. The launcher separately marks its fence as mandatory; a missing or failed trash service cannot downgrade admission to the official unfenced path. Initialization faults keep an active refusing service instead of unloading it. With no Desktop trash service the official runtime behavior stays unchanged.

The compatibility client owns its original presentation; Desktop registers new public menu/overlay/settings slots. Beta owns development, then shared sources are mirrored to Stable with separate patches for their different exact core versions.

## Required invariants

1. Confirm the exact Session before a mutation. Cancel sends nothing. Connection authentication and same-origin loopback checks run before body parsing or changing state.
2. Activity, an unknown identity, unavailable capability, or an uncertain persistence state refuses deletion. The current selection changes only after an accepted marker commit.
3. Public Controller mutations hold the same per-identity marker lock as the trash commit. Admission is fenced while the history flush and marker commit are pending. A cold target must grant a public write-ownership probe; a foreign writer is refused, and the probe is held until marker commit or failure. Failed writes leave committed membership intact. Catalog filtering reads committed membership, so a pending/failed operation never hides a row.
4. All generations and branch references remain physically readable to their existing domain owners. No persistence handle is confiscated and no immutable log or lock file is removed.
5. Per-identity metadata writes cannot overwrite another identity's state. Corrupted or unreadable markers fail closed. Normal Host restart reloads the same committed membership.
6. Restore retains original Archive state and ordering. A failed catalog notification does not misreport a committed mutation as a failed storage write.
7. Unsupported runtime composition is reported accurately and cannot mutate trash state.

## Cross-Host counterexample

The following interleaving defeats a deletion implementation that checks `list()` and only locks the target session.

1. Host B opens source session P for read and prepares a fork C with `parentSession = P`. Reads hold no write lease.
2. B creates C, whose pending header is visible only to B. Its generation is not yet materialized.
3. Host A lists the store. C is absent, so A concludes P has no dependent child.
4. A acquires P's write lease. B's read/fork preparation does not conflict with that lease.
5. A removes P's generations and acknowledges deletion.
6. B appends or flushes C, publishing a surviving reference to the deleted source P.

A second list under P's lease does not fix this case. B can still carry a pending child. The exact JSONL APIs permit this ordering. A test that only mocks a local session list would hide the unsafe assumption.

## Why physical reclamation is deferred

The counterexample above makes physical removal unsafe without a lineage admission contract shared by all parent-bearing create/fork operations and by deletion. Logical deletion keeps the source log available even if a concurrent fork materializes later. Its independent identity remains usable. This resolves the report's session-management path without claiming to erase data. A later garbage-collection proposal needs its own ownership, reference and crash-recovery evidence.

The inherited atomic-write helper guarantees complete-file replacement and writer coordination. Its public contract explicitly excludes power-loss fsync durability. This feature uses the same normal-process-restart persistence boundary as existing Desktop private preferences and does not add a claim about sudden power failure.

## Verification evidence

`node --test scripts/session-trash-runtime.test.mjs` runs methods taken from the exact vendored Stable/Beta artifacts after applying their committed Yarn patches. Setting `DSH_ISSUE369_UNPATCHED=1` retains the same new tests and skips only those implementation patches.

The final suite has 36 cases over both exact runtime versions and both shipped module entry paths. It covers catalog/search exclusion, asynchronous search interleaving, resume/adopt/fork refusal, mutation/history entry guards, model-step admission, a missing mandatory fence, late-fault cleanup of a newly acquired factory handle, and unchanged behavior without Desktop composition. The same script is run against unpatched, patched and installed artifacts; final counts are recorded in the PR receipt.

A narrower saved implementation from before the ownership-probe fix is run with the new native lease-hold regression unchanged. Its result is `Tests 1 failed | 8 skipped (9)`; the current implementation produces `Tests 1 passed | 8 skipped (9)`. A separate real child process holds the JSONL write lease and confirms a 409 foreign-owner refusal. The patch from before late-fault handle cleanup produces `# tests 36 / # pass 32 / # fail 4`; the corrected patch produces `# tests 36 / # pass 36 / # fail 0`.

Package-focused tests also exercise real Cordis corrupt initialization, lost/replaced root handling, cross-process marker visibility, atomic-write/flush failure, unauthorized requests, canceled confirmation, DOM button wiring, restoration and unsupported capability. Native Windows UI and semaphore behavior have not been executed on this macOS host; the DOM suite supplies the HTML dialog methods omitted by jsdom. No Windows run is inferred from a mocked platform value.
