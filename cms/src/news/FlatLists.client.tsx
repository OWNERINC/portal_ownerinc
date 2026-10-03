'use client'

import { useEffect } from 'react'
import { createClientFeature } from '@payloadcms/richtext-lexical/client'
import { useLexicalComposerContext } from '@payloadcms/richtext-lexical/lexical/react/LexicalComposerContext'
import { registerFlatLists } from './flat-lists'

function FlatListsPlugin() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => registerFlatLists(editor), [editor])
  return null
}
export const FlatListsFeatureClient = createClientFeature({ plugins: [{ Component: FlatListsPlugin, position: 'normal' }] })
