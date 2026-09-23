/// Which entries of the room log this client has taken in, by index.
///
/// A snapshot tells the server "everything below this index is in here", and
/// the server throws those entries away. So the index has to be exact where it
/// errs: one too high loses whatever the snapshot does not hold, for everyone
/// who joins afterwards. Without indexes on relayed updates the only safe
/// guess was this client's own stored updates, which fell further behind the
/// more other people typed — and the server refused it outright once a member
/// with fewer of its own became the snapshotter, since a snapshot may never
/// move backwards. Compaction then stopped for the rest of the room's life,
/// and a long session filled its log and began refusing edits.
///
/// An entry counts once its content is in the document: applied, one of ours
/// acknowledged, or covered by a snapshot applied here. A part of a split
/// update counts only when the whole update has been applied.
export class LogCursor {
  /// Every index below this has been taken in.
  private through = 0;
  /// Indexes at or above `through` taken in out of order, waiting for the gap
  /// below them to fill.
  private above = new Set<number>();

  /// The highest index a snapshot taken now may claim to cover, and where a
  /// sync should resume from.
  get watermark(): number {
    return this.through;
  }

  note(index: number): void {
    if (!Number.isSafeInteger(index) || index < this.through) return;
    this.above.add(index);
    this.advance();
  }

  /// A snapshot covering everything below `covers` has been applied.
  noteBelow(covers: number): void {
    if (!Number.isSafeInteger(covers) || covers <= this.through) return;
    this.through = covers;
    for (const i of this.above) if (i < covers) this.above.delete(i);
    this.advance();
  }

  /// The log this counted is gone — a room brought back after a restart
  /// starts a new one at zero.
  reset(): void {
    this.through = 0;
    this.above.clear();
  }

  private advance(): void {
    while (this.above.delete(this.through)) this.through += 1;
  }
}
