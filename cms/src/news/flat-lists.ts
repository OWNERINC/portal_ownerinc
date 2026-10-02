import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_CRITICAL, INDENT_CONTENT_COMMAND, type LexicalEditor } from '@payloadcms/richtext-lexical/lexical'
import { $isListItemNode, $isListNode } from '@payloadcms/richtext-lexical/lexical/list'

/** ListFeature has no maxDepth option. Block nesting through the public command API. */
export function registerFlatLists(editor: LexicalEditor) {
  return editor.registerCommand(INDENT_CONTENT_COMMAND, () => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return false
    return selection.getNodes().some(node => $isListNode(node) || $isListItemNode(node) ||
      node.getParents().some(parent => $isListItemNode(parent)))
  }, COMMAND_PRIORITY_CRITICAL)
}
