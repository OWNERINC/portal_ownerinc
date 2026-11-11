// Layout drag payloads are not rich-text content. Return false for ordinary
// text drops so ProseMirror keeps its normal text/selection drop behavior.
export function compositionDropGuard(isLayoutDragging = () => false) {
  return (_view, event) => {
    if (!isLayoutDragging()) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
}
