/// Markdown export: the source, exactly as written, with nothing rendered.
///
/// The PDF path exists for reading; this one exists for keeping. It writes
/// what is in the editor rather than what the preview made of it, so the file
/// round-trips back into any editor unchanged.
const CONFIRM_COPY =
  "This writes an unencrypted file to your computer. RÚNA cannot shred that copy.";

let confirmedThisSession = false;

/// Deliberately carries no room identifier.
///
/// A downloaded file outlives the room and the browser session, and lands
/// somewhere RÚNA has no reach — a downloads folder, a backup, a sync client.
/// Naming it after the room would write that room's address into all three,
/// where the whole design is that the address is only ever in a link somebody
/// chose to share. A timestamp is enough to tell two exports apart.
export function markdownFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `runa-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.md`;
}

/// Returns false when nothing was written: an empty document, or a refused
/// confirmation. The caller uses that to avoid claiming a download happened.
export function exportMarkdown(source: string, now: Date = new Date()): boolean {
  if (source.length === 0) return false;
  if (!confirmedThisSession && !window.confirm(CONFIRM_COPY)) return false;
  confirmedThisSession = true;

  // text/markdown rather than text/plain so a phone offers a sensible app,
  // and an explicit charset because the document may hold anything.
  const blob = new Blob([source], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = markdownFilename(now);
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick rather than immediately: Safari has been known to
  // cancel a download whose object URL is released in the same frame.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
