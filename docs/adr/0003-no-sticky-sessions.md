# ADR 0003: Stateless instances, no sticky sessions, Redis pub/sub relay

**Status:** accepted

## Context

M5 requires 3+ instances. Collaborators on one document should not all need to land on the same instance, and losing an instance must not lose edits or need manual intervention.

## Decision

- nginx load-balances round-robin **with no affinity**. Any instance accepts any document.
- Each instance with clients on a document holds an in-memory replica (a _room_) and subscribes to a Redis channel per document carrying updates, presence, and control events. Envelopes carry the origin instance ID, so echoes are ignored.
- **Single writer per edit:** only the instance whose client produced an update persists it. Relayed copies are applied in memory only.
- **Opening a room:** subscribe → load from DB → publish `SYNC_REQUEST(state vector)`. Peers reply with the diff and their clients' presence. Subscribing _before_ loading means no update can fall between "persisted" and "received".
- **Failover:** clients reconnect with jittered backoff. nginx fails over (2 s connect timeout, next upstream) and re-resolves restarted containers. The Yjs handshake resends whatever either side is missing.

## Consequences

- The chaos test SIGKILLs one of three instances under 500 clients: 166 sockets failed over (resync p99 0.93 s), 113,962 / 113,962 edits were delivered, and all 25 documents converged and reloaded intact from Postgres.
- REST changes on one instance (rename, role change, revoke) reach sockets on any other through the same channel. Revoked users are disconnected within milliseconds cluster-wide.
- Cost: every update crosses Redis once per instance holding the room. Fan-out per document is O(instances), not O(1).
- Cost: after failover, connections stay where they landed (no rebalancing). New connections spread evenly again.

## Alternatives considered

- **Sticky sessions or consistent hashing by document ID:** simpler relay, but a hot document is capped by one instance. Rebalancing on scale events moves live sockets, and an instance death still needs a takeover protocol.
- **Leader per document (OT-style):** requires coordination (leases, elections) that the CRDT makes unnecessary.
