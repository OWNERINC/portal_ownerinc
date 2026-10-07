#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorCode, fail } from './payload-preview/errors.mjs'
import { assertValidPort } from './payload-preview/security.mjs'
import { displayPath } from './payload-preview/render.mjs'
import {
  checkHttpsPreparationSources,
  prepareHttpsRecovery,
} from './payload-preview/https.mjs'

const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helpText = `Prepare-only HTTPS recovery artifacts for an existing private Payload preview run

Usage:
  node scripts/prepare-payload-preview-https.mjs --help
  node scripts/prepare-payload-preview-https.mjs --check
  node scripts/prepare-payload-preview-https.mjs prepare --run-directory <existing-absolute-run-directory> --output-directory <new-direct-child> --project <ownerinc-payload-preview-runid> --https-port <free-loopback-port> --certificate <absolute-cert.pem> --private-key <absolute-key.pem> [--base-override <existing-absolute-compose-override>]

The project name must match the private run's Compose metadata. The output must
be a new recovery-https-* child of that run. Preparation reads only the run's
non-secret identity fields, copies a validated local certificate/key into new
private artifacts, and never invokes Docker or starts services.
An earlier recovery/base override is never auto-discovered; pass --base-override
explicitly when the existing run requires one.
`

const requiredOptionNames = [
  '--run-directory', '--output-directory', '--project', '--https-port', '--certificate', '--private-key',
]
const optionalOptionNames = ['--base-override']
const optionNames = [...requiredOptionNames, ...optionalOptionNames]

export function parseCommandLine(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { mode: 'help' }
  if (args.length === 1 && args[0] === '--check') return { mode: 'check' }
  if (args[0] !== 'prepare') fail('usage')

  const options = new Map()
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index]
    if (!optionNames.includes(name) || options.has(name)) fail('usage')
    const value = args[index + 1]
    if (!value || value.startsWith('--')) fail('usage')
    options.set(name, value)
    index += 1
  }
  if (requiredOptionNames.some(name => !options.has(name))) fail('usage')

  const runDirectory = options.get('--run-directory')
  const outputDirectory = options.get('--output-directory')
  const projectName = options.get('--project')
  const certificate = options.get('--certificate')
  const privateKey = options.get('--private-key')
  const baseOverride = options.get('--base-override')
  for (const directory of [runDirectory, outputDirectory]) {
    if (!path.isAbsolute(directory) || directory.includes('\0')) fail('directory_must_be_absolute')
  }
  for (const filePath of [certificate, privateKey]) {
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) fail('tls_path_must_be_absolute')
  }
  if (baseOverride !== undefined && (!path.isAbsolute(baseOverride) || baseOverride.includes('\0'))) {
    fail('base_override_must_be_absolute')
  }
  if (!/^ownerinc-payload-preview-[a-f0-9]{8,24}$/u.test(projectName)) fail('run_project_identity_invalid')
  if (!/^\d{1,5}$/u.test(options.get('--https-port'))) fail('usage')
  const httpsPort = assertValidPort(Number(options.get('--https-port')), 'https')
  return {
    mode: 'prepare',
    runDirectory,
    outputDirectory,
    projectName,
    httpsPort,
    certificate,
    privateKey,
    ...(baseOverride === undefined ? {} : { baseOverride }),
  }
}

function printPreparedSummary(result) {
  process.stdout.write('Prepared private HTTPS recovery artifacts. No services were launched.\n')
  process.stdout.write(`Run directory: ${displayPath(result.runDirectory)}\n`)
  process.stdout.write(`Recovery artifacts: ${displayPath(result.outputDirectory)}\n`)
  process.stdout.write(`Compose project: ${result.projectName}\n`)
  process.stdout.write(`HTTPS origin: ${result.origin} (loopback only)\n`)
  process.stdout.write('The recovery launcher reuses the existing Compose project, env file, volumes, and image tags; it does not build images.\n')
  process.stdout.write(`PowerShell launcher: & '${displayPath(result.powershellLauncher).replace(/'/gu, "''")}'\n`)
  process.stdout.write(`POSIX launcher: sh '${displayPath(result.shellLauncher).replace(/'/gu, "'\\''")}'\n`)
  process.stdout.write('Review the generated Compose override before any separately authorized launch.\n')
}

async function main(args) {
  let command
  try { command = parseCommandLine(args) } catch (error) {
    process.stderr.write(`PREVIEW_HTTPS_PREPARE_BLOCKED ${errorCode(error)}\n`)
    process.stderr.write('Run with --help for usage.\n')
    process.exitCode = 2
    return
  }

  if (command.mode === 'help') {
    process.stdout.write(helpText)
    return
  }

  try {
    if (command.mode === 'check') {
      const result = await checkHttpsPreparationSources({ root: checkoutRoot, fileSystem: fs })
      process.stdout.write(`Offline HTTPS recovery source contracts OK. Compose ${result.composeMinimumVersion}+ required to launch; no private run, Docker, or services were accessed.\n`)
      return
    }
    const result = await prepareHttpsRecovery({ root: checkoutRoot, fileSystem: fs, ...command })
    printPreparedSummary(result)
  } catch (error) {
    process.stderr.write(`PREVIEW_HTTPS_PREPARE_BLOCKED ${errorCode(error)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
