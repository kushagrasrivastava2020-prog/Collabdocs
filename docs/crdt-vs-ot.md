# CRDT vs OT: why CollabDocs uses Yjs

Real-time co-editing comes down to one problem. Two people change the same document at the same time, each starting from a slightly stale copy, and every replica must still end up identical without losing either person's intent. The two established solutions are **Operational Transformation (OT)** and **Conflict-free Replicated Data Types (CRDTs)**.

## Operational Transformation

OT represents edits as position-based operations: `insert("x", 5)`, `delete(3, 2)`. When an operation arrives that was made against an older version, it is **transformed** against the operations it missed. If someone inserted 3 characters before position 5, `insert("x", 5)` becomes `insert("x", 8)`.

- **Pros:** compact operations and a document model that stays plain text or a plain tree. It is battle-tested: Google Docs, and ShareDB/ot.js in open source.
- **Cons:** it needs a **central server that imposes a total order** on operations. That is in practice; in theory, peer-to-peer OT requires transformation properties (TP2) that most published algorithms got wrong. Transformation functions grow quadratically with the number of operation types, which is painful for rich text with marks, lists, and tables. Offline editing is hard too: a client that was away for an hour has a long queue of operations to transform against a long server history.

## CRDTs

A CRDT makes concurrent operations **commute by construction**, so no transformation step exists. Yjs (a YATA-style sequence CRDT) gives every inserted character a unique ID `(clientID, clock)` and records its left and right neighbours _at the moment of insertion_. Deletes mark items as tombstones. A deterministic rule orders concurrent inserts at the same spot, so every replica that has received the same _set_ of updates is in the same state, **regardless of order or duplication**.

- **Pros:**
  - No central ordering is needed. Updates are idempotent and commutative.
  - Offline support is natural: the sync protocol exchanges _state vectors_ (the highest clock seen per client) and ships only the missing updates.
  - Merges are deterministic and need no server-side logic about the document's meaning, so the server can be a relay plus a log.
  - Positions can be expressed as `RelativePosition` (an item ID instead of an offset), so they survive concurrent edits.
- **Cons:**
  - Metadata overhead: per-item IDs, plus tombstones that are never truly removed while history matters. Yjs mitigates this heavily by run-length encoding consecutive characters from one client into a single item, and by garbage-collecting deleted content.
  - Interleaving anomalies are possible in rare concurrent cases. YATA avoids the worst ones.
  - Fine-grained permission checks are harder, because an update is an opaque binary diff, not a "set title" command.

## Why CollabDocs chose a CRDT (Yjs)

| Requirement                    | OT                                                                                                 | CRDT (Yjs)                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Multiple server instances (M5) | All ops for a doc must funnel through **one** sequencer: sticky routing or a single leader per doc | Any instance can accept any edit; instances just relay updates over Redis, in any order |
| Offline edits (M4)             | Long transformation chains on reconnect                                                            | State-vector diff in **one round trip** (`sync step 1/2`)                               |
| Durable op log (M4)            | Ops are only meaningful with their base version                                                    | Each log row is a self-contained, idempotent update; replaying duplicates is harmless   |
| Rich text (M1)                 | Custom transform functions per node/mark type                                                      | `y-prosemirror` / TipTap binding maps the ProseMirror tree onto `Y.XmlFragment`         |
| Comment anchors (M6)           | Must transform every anchor with every op                                                          | `Y.RelativePosition` anchors move with the text automatically                           |

The deciding factor was **horizontal scaling**. With OT, three server instances need a single authority per document to order operations, which means sticky sessions, leader election, or a lock. With Yjs, the load balancer can send two collaborators on the same document to _different_ instances. Each instance applies updates in whatever order Redis delivers them, and the replicas still converge. The cluster tests and the 500-client load test check this directly: every replica of every document ended in an identical state.

The CRDT also made several robustness features nearly free:

- **Crash recovery and anti-entropy:** after a crash, clients reconnect and resend what the server lacks. A room that unloads appends any in-memory difference to the log, and duplicates are harmless.
- **Version restore as a normal edit:** restoring an old snapshot is just a new transaction that replaces the content, so concurrent editors converge as usual.
- **Server-side enforcement:** viewers and commenters are blocked at the protocol level by dropping their sync-step-2 and update messages. No document-level understanding is required.

**Costs I accepted:** the op log stores binary Yjs updates rather than human-readable operations, and documents carry tombstone metadata. Snapshots bound load time: loading reads the latest snapshot plus the log tail. An infinitely growing log can be pruned behind the oldest retained snapshot if history depth is capped.
