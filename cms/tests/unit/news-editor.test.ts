import assert from 'node:assert/strict'
import test from 'node:test'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import { $createParagraphNode, $createTextNode, $getRoot, COMMAND_PRIORITY_LOW, INDENT_CONTENT_COMMAND } from '@payloadcms/richtext-lexical/lexical'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@payloadcms/richtext-lexical/lexical/list'
import { $createHeadingNode, HeadingNode } from '@payloadcms/richtext-lexical/lexical/rich-text'
import { $createLinkNode, LinkNode } from '@payloadcms/richtext-lexical'
import { registerFlatLists } from '../../src/news/flat-lists'
import { lexicalToRich } from '../../src/news/lexical-to-rich'

test('converter accepts real pinned Lexical/Payload serialization including Payload v3 links', () => {
  const editor = createHeadlessEditor({ nodes: [HeadingNode, ListNode, ListItemNode, LinkNode], onError: error => { throw error } })
  editor.update(() => {
    const bold = $createTextNode('Bold').toggleFormat('bold')
    const link = $createLinkNode({ fields: { linkType: 'custom', newTab: true, url: 'https://example.test/' } }).append(bold)
    $getRoot().append($createHeadingNode('h1').append($createTextNode('Heading')),
      $createParagraphNode().append(link),
      $createListNode('number').append($createListItemNode().append($createTextNode('Item'))))
  }, { discrete: true })
  assert.deepEqual(lexicalToRich(editor.getEditorState().toJSON()), [
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Heading', marks: [] }] },
    { type: 'paragraph', children: [{ type: 'link', url: 'https://example.test/', new_tab: true,
      children: [{ type: 'text', text: 'Bold', marks: ['bold'] }] }] },
    { type: 'list', ordered: true, items: [[{ type: 'text', text: 'Item', marks: [] }]] },
  ])
})

test('public flat-list command extension blocks nesting even with a link selected, and unregisters cleanly', () => {
  const editor = createHeadlessEditor({ nodes: [ListNode, ListItemNode, LinkNode], onError: error => { throw error } })
  const unregister = registerFlatLists(editor)
  let lowerPriorityCalls = 0
  editor.registerCommand(INDENT_CONTENT_COMMAND, () => { lowerPriorityCalls++; return true }, COMMAND_PRIORITY_LOW)
  editor.update(() => {
    const text = $createTextNode('Item')
    const link = $createLinkNode({ fields: { linkType: 'custom', newTab: false, url: 'https://example.test/' } }).append(text)
    $getRoot().append($createListNode('bullet').append($createListItemNode().append(link)))
    text.select()
    editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)
  }, { discrete: true })
  assert.equal(lowerPriorityCalls, 0)
  unregister()
  editor.update(() => { editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined) }, { discrete: true })
  assert.equal(lowerPriorityCalls, 1)
})
