const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** Should a global shortcut (Ctrl+Z) leave this target alone? Only where the user types:
 *  sliders, checkboxes and selects have no native undo, so the editor's undo applies. */
export function isTextEntry(t: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA') return true;
  if (t.tagName === 'INPUT') return !NON_TEXT_INPUTS.has((t.type ?? '').toLowerCase());
  return false;
}
