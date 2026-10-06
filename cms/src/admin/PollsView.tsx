import React from 'react'
import type { AdminViewServerProps } from 'payload'
import { DefaultTemplate } from '@payloadcms/next/templates'
import { PollsWorkspace } from './PollsWorkspace'
export function PollsView(props: AdminViewServerProps) {
  return <DefaultTemplate {...props} {...props.initPageResult}><PollsWorkspace /></DefaultTemplate>
}
