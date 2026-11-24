# ADR 0004: Enforce permissions on the server, at the protocol level

**Status:** accepted

## Context

Share links grant view, comment, or edit access. A CRDT client can produce arbitrary binary updates, so client-side read-only mode is not a security boundary.

## Decision

- **REST:** every document route resolves the caller's role. Users with no access get **404**, never 403, so document IDs can't be probed.
- **WebSocket:** viewer and commenter sockets may sync _down_ and share presence, but the server drops their `sync step 2` and `update` messages before they touch the replica. Rejections are counted in metrics.
- **Presence integrity:** awareness payloads are client JSON. The server overwrites `user.{id,name,color,role}` with the authenticated identity, refuses to modify client IDs owned by another socket, and caps the size of each state.
- **Live revocation:** a role change publishes an `access` control event. Each instance re-checks affected sockets, then downgrades them or closes them with `4403`, which y-websocket treats as terminal.
- **Abuse limits:** token bucket per socket (100 msg/s sustained, bursts of 200; close `4529`, which is retryable), 16 MB frame cap, slow-consumer cutoff at 8 MB buffered, auth rate limiting.
- **Web hardening:** httpOnly + SameSite=Lax session cookie, Origin allow-list for WebSockets (CSWSH), strict CSP for the SPA, `X-Frame-Options: DENY`.

## Consequences

- A modified client can't write to a document it can only view. Tests cover this by sending updates from viewer and commenter sockets.
- Comments live in Postgres rather than in the CRDT, so the commenter role can be enforced by ordinary REST checks. They are still anchored with CRDT relative positions.
- Cost: role checks happen on connect and on change events, not per message. A role change takes effect after one pub/sub hop.
