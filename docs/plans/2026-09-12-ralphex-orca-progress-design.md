# Ralphex progress updates for Orca

## Goal

Keep Orca's Ralphex activity timestamp current using meaningful workflow progress rather than a periodic heartbeat.

## Design

Ralphex will emit a package-level `ralphex:progress` event when its visible workflow advances: planning starts or invokes a tool, a task starts or advances to a checkbox or validation step, review or fixing advances, and release or Git finalization advances. Streaming model text will remain UI-only to avoid flooding Orca with HTTP requests. Consecutive duplicate progress descriptions will be suppressed.

The Orca status bridge will listen for `ralphex:progress` only while a Ralphex operation is active. Each accepted event will post another `agent_start` hook with the concise activity as its prompt, refreshing Orca's last-update timestamp. Existing `ralphex:started`, `ralphex:completed`, and `ralphex:failed` lifecycle behavior remains unchanged. Progress received outside an active operation is ignored.

No timer or heartbeat will be added. A single operation that produces no meaningful event for more than Orca's stale threshold may still display `No update`.

## Validation

Extend the Ralphex and Orca status tests to cover progress emission, forwarding, duplicate suppression, and lifecycle boundaries. Run `npm test`.
