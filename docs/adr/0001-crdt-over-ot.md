# ADR 0001: Use a CRDT (Yjs), not Operational Transformation

**Status:** accepted

## Context

Concurrent edits must merge without losing anyone's intent. The service must scale across several stateless instances (M5) and accept edits made offline (M4).

## Decision

Represent every document as a Yjs `Y.Doc`. The rich-text body is a `Y.XmlFragment` bound to ProseMirror/TipTap. Clients and servers exchange binary Yjs updates and state vectors over the standard y-websocket protocol.

## Consequences

- Updates are **commutative and idempotent**, so instances can apply them in any order, duplicates are harmless, and no per-document sequencer is needed (see [ADR 0003](0003-no-sticky-sessions.md)).
- Offline sync is a single state-vector exchange (sync step 1/2) in each direction.
- Recovery paths are simple: replaying or re-sending an update is always safe, which is what makes the anti-entropy step in [ADR 0002](0002-op-log-and-snapshots.md) correct.
- Positions can be expressed as `Y.RelativePosition`, so comment anchors survive concurrent edits for free.
- Cost: tombstone metadata, and the op log stores opaque binary rather than readable operations.
- Cost: ProseMirror ↔ Yjs translation is diff-based (y-prosemirror). Indistinguishable sibling nodes (e.g. two empty paragraphs) can be attributed to the wrong CRDT element under concurrent structural edits. CollabDocs disables auto-inserted trailing paragraphs to avoid creating such nodes from many clients at once.

## Alternatives considered

- **OT (ShareDB-style):** needs a single ordering authority per document, which means sticky routing or leader election across instances. Long transformation chains after offline periods. Custom transform functions for every rich-text node and mark type.
- **Last-writer-wins on blocks:** simple, but loses concurrent edits inside the same paragraph.

The full comparison is in [crdt-vs-ot.md](../crdt-vs-ot.md).
