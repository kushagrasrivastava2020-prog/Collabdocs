# ADR 0002: Append-only op log + snapshots built from the database

**Status:** accepted

## Context

Edits arrive at many instances at keystroke rate. Loading a document must stay fast as its history grows, and history must support version restore and replay.

## Decision

- **`doc_updates`** is the append-only op log of binary Yjs updates. Each instance buffers its own clients' updates for 50 ms and writes **one row per author** per flush (merged with `Y.mergeUpdates`). Rows are never rewritten.
- **Gap-free sequence numbers:** `UPDATE documents SET update_seq = update_seq + 1 … RETURNING` inside the insert transaction. The row lock serialises appends per document _across all instances_, so commit order equals seq order and any reader sees a clean prefix of the log.
- **`doc_snapshots`** is the compacted state covering `seq ≤ snapshot.seq`, written every 100 appends or 60 s of activity, on room unload, and on demand (named versions). Snapshots are **built from the database**, not from an instance's in-memory replica.
- **Load** = latest snapshot + log tail.
- **Durability acks:** after each append, the server sends the client the state vector it covers. The UI shows "Saved" only when the acked clock for the client's own ID has caught up.
- **Anti-entropy:** when a room unloads, the instance compares its replica with the DB (`Y.equalSnapshots`) and appends any difference.

## Consequences

- Restore and time-travel are cheap and exact: replaying rows `1..n` reproduces the state after write _n_.
- Snapshots are correct even when instances race to create them. Building from memory would have needed a `seq` that the in-memory replica can't know (relayed updates from other instances may not be committed yet).
- A node killed with unflushed writes loses nothing. Its relayed updates live on in peers' replicas, and their unload reconciliation persists them. The fuzz test kills a node with a 5 s flush window and requires the DB to match. Disabling the reconciliation makes every seed fail (mutation-checked).
- Cost: one row lock per document per flush caps write throughput _per document_ (thousands of appends/s); batching keeps actual rates far below that.
- Cost: the log grows forever. Pruning behind the oldest retained snapshot is a possible future change.

## Alternatives considered

- **Store full state on every write:** O(document size) write amplification per keystroke batch.
- **Snapshot from memory with "max seq seen":** racy across instances, because uncommitted rows with lower seqs get skipped on load.
- **Global `BIGSERIAL` ids:** commit order ≠ id order across concurrent transactions, so a reader can observe gaps that fill in later.
