// Adapted from templates/blank at Payload v3.90.2.
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import config from '@payload-config'
import { RootPage, generatePageMetadata } from '@payloadcms/next/views'
import { importMap } from '../importMap.js'
import { PortalLogoutView } from '../../../../../admin/PortalLogout'

type Args = {
  params: Promise<{ segments: string[] }>
  searchParams: Promise<{ [key: string]: string | string[] }>
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams })

const Page = async ({ params, searchParams }: Args) => {
  const { segments = [] } = await params
  if (['login', 'create-first-user', 'forgot', 'reset'].includes(segments[0])) redirect('/editorial-entry.html')
  // GET only renders; the browser confirms a same-origin DELETE before leaving.
  if (segments[0] === 'logout') return <PortalLogoutView />
  return RootPage({ config, params, searchParams, importMap })
}

export default Page
