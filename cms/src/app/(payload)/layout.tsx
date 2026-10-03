// Adapted from templates/blank at Payload v3.90.2.
import config from '@payload-config'
import '@payloadcms/next/css'
import './editorial.css'
import type { ServerFunctionClient } from 'payload'
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import React from 'react'
import { headers } from 'next/headers'
import { assertEditorialOrigin } from '../../auth/cookie'

import { importMap } from './editorial/admin/importMap.js'

export const dynamic = 'force-dynamic'

type Args = { children: React.ReactNode }

const serverFunction: ServerFunctionClient = async function (args) {
  'use server'
  assertEditorialOrigin(await headers(), (await config).serverURL)
  return handleServerFunctions({ ...args, config, importMap })
}

const Layout = ({ children }: Args) => (
  <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
    {children}
  </RootLayout>
)

export default Layout
