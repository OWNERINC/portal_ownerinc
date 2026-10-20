'use client'

import React, { useMemo, useRef } from 'react'
import { TextField } from '@payloadcms/ui'
import type { TextFieldClientProps } from 'payload'
import { useEditorialFieldFocusTarget } from './editorial-focus'

/** Payload-native required text field whose actual input participates in Task 2 validation focus. */
export function PortalPageRequiredTextField(props: TextFieldClientProps): React.JSX.Element {
  const registerTarget = useEditorialFieldFocusTarget<HTMLInputElement>(props.path)
  const nodeRef = useRef<HTMLInputElement | null>(null)
  const inputRef = useMemo(() => ({
    get current(): HTMLInputElement | null { return nodeRef.current },
    set current(node: HTMLInputElement | null) {
      nodeRef.current = node
      registerTarget(node)
    },
  }) as unknown as React.RefObject<HTMLInputElement>, [registerTarget])

  return <TextField {...props} inputRef={inputRef} />
}
