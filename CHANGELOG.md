# Changelog

Newest first. The release workflow reads the section matching the tag and
publishes it as the release notes, and refuses to build a tag that has no
section — so this file is not documentation of the release, it is part of it.

## 0.3.0

### Added

- **Export as Markdown.** The source exactly as typed, rather than what the
  preview made of it, so the file opens anywhere and comes back unchanged.
  The PDF is the export for reading; this is the export for keeping. The
  filename is a timestamp and carries no room identifier: a downloaded file
  outlives the room and lands where RÚNA has no reach, and naming it after
  the room would write that address into a downloads folder, a backup, and
  whatever syncs them.
- **Choose how much fits on a PDF page.** Compact, Normal or Large. The print
  stylesheet previously set page geometry but never a type size, so the PDF
  inherited the screen's typography and a 2,500-line document came out at
  sixty-odd pages with no recourse. Margins move with the type, because on A4
  the margins are a large share of the page and shrinking type alone buys far
  less than it appears to. Compact fits roughly twice as much per page as
  Large.
- **A divergent copy now repairs itself.** When copies disagree, the client
  asks the relay for the whole document — snapshot and full tail — instead of
  only reporting the problem. The warning appears when that did not work, and
  says so; it clears itself when the copies agree, and offers another attempt.
  Previously the only cure was reloading the page.

### Fixed

- **A shred request reached nobody after a reconnect.** Switching tabs and
  coming back left the previous connection's peer id in the roster for good,
  because the server's authoritative roster was merged into the client's
  rather than replacing it. Two reconnects meant four entries where two people
  were, so the vote asked three of four to approve — and because the roster's
  hash travels inside a signed shred request and every receiver re-derives it,
  an inflated roster hashed differently from everyone else's and every peer
  silently refused the request. A refusal to take part in a shred vote is also
  no longer discarded in silence.
- **The occupant count follows who is actually present.** It came from a
  join-time snapshot patched with the events a client happened to receive, so
  a missed departure over-counted for the rest of the session and four devices
  in one room could report four different numbers at the same moment.
- **A 24-hour room no longer accuses its own server of tampering.** The server
  reports the time remaining for an absolute expiry, which is necessarily less
  than the duration the room was created with, and the client compared the two
  directly — so every such room raised the tamper banner within a minute. A
  warning that is always on is worse than none. `JOIN_ACK` now carries how
  long the room has been alive so the two can be compared like with like, and
  a room that was legitimately extended is not flagged.

## 0.2.1

### Fixed

- **Line endings silently corrupted other peers' copies.** Monaco keeps one
  end-of-line sequence per document and rewrites inserted text to match it,
  while the shared document stores exactly what it is given. A client whose
  editor used CRLF — in practice, Windows — drifted one character per newline
  from everyone else, so text landed in the wrong place on other machines, a
  deletion removed the wrong range, and lines appeared merged on one client
  and separate on the rest. This is the reason to prefer 0.2.1 over 0.2.0.
- **The "your copy differs" warning fired on identical documents.** It
  compared the local document against hashes peers had broadcast up to a
  heartbeat earlier, on every update, and never cleared once raised — so two
  byte-identical copies could both display it for the rest of a session.
- **Equations rendered flat.** `$E = mc^2$` came out as "E=mc2" because
  KaTeX's HTML output positions superscripts with inline styles that the
  sanitizer correctly strips. Maths is emitted as MathML now, which carries
  the structure in the markup, needs no stylesheet and ships no fonts.
- **Preview mode showed the editor**, and no toggle looked selected. The
  layout control is now three tabs, one press each, with the active one
  marked.
- **Toolbar buttons ignored the selection.** Heading wrote the literal words
  "## Heading" over what you had selected, the code fence produced an empty
  fence with the line's text welded to its closing delimiter, and the task
  list inserted the word "task". The emphasis buttons left the caret outside
  the markers when nothing was selected.
- **The selected layout tab was outlined on three sides**, because adjacent
  tabs shared an edge by deleting one border.
- **Tapping a line on iOS zoomed the page** and left the shred dialog cropped,
  because the editor's hidden input sat below the 16px threshold at which
  Safari zooms on focus.
- **The occupant count** no longer comes from a roster snapshot that drifts.

### Changed

- The renderer no longer permits SVG at all. Those allowances existed solely
  for KaTeX's HTML output, which is no longer produced.

## 0.2.0

First public release. Multi-arch container image, keyless Sigstore signatures
on the binaries and the image, CycloneDX bills of materials for both halves,
and a landing page that fits on one screen.

**Superseded.** 0.2.0 contains the line-ending fault described under 0.2.1: a
Windows client joining a room silently corrupted every other participant's
copy. Do not run it.
