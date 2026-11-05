// desktop-mt: ⌘F / Ctrl+F while the PDF viewer (app/chat/right-rail/pdf-preview.tsx)
// has focus opens the viewer's own search, which searches the whole PDF, rather
// than the app's find bar over the chat (app/hooks/use-keybinds.ts). Reads the
// document, so it stays out of lib/find-in-page.ts, which is pure logic.
export function findInPageTakenByViewer(): boolean {
  return document.activeElement?.closest('[data-pdf-viewer]') != null
}
