// Adapted from templates/blank at Payload v3.90.2.
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import config from '@payload-config'
import { RootPage, generatePageMetadata } from '@payloadcms/next/views'
import { importMap } from '../importMap.js'

type Args = {
  params: Promise<{ segments: string[] }>
  searchParams: Promise<{ [key: string]: string | string[] }>
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams })

const Page = async ({ params, searchParams }: Args) => {
  const { segments = [] } = await params
  if (['login', 'create-first-user', 'forgot', 'reset'].includes(segments[0])) redirect('/editorial-entry.html')
  // GET only navigates. Task 9's exit view must confirm DELETE before claiming logout.
  if (segments[0] === 'logout') redirect('/editorial-entry.html?logout=1')
  return RootPage({ config, params, searchParams, importMap })
}

export default Page
