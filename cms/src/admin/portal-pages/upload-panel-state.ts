export type PortalPageMediaEditability = {
  fieldDisabled: boolean
  readOnly: boolean
  formDisabled: boolean
  locked: boolean
  processing: boolean
  backgroundProcessing: boolean
  initializing: boolean
  documentInitializing: boolean
}

export function isPortalPageMediaEditable(state: PortalPageMediaEditability): boolean {
  return !state.fieldDisabled && !state.readOnly && !state.formDisabled && !state.locked &&
    !state.processing && !state.backgroundProcessing && !state.initializing && !state.documentInitializing
}

export type UploadDrawerCloseAction = 'no-change' | 'close-panel' | 'confirm-and-reopen'

/** Resolve native Payload modal transitions without treating initial/open renders as close events. */
export function resolveUploadDrawerClose(previousOpen: boolean, isOpen: boolean, active: boolean,
  hasSession: boolean): UploadDrawerCloseAction {
  if (!previousOpen || isOpen) return 'no-change'
  return active || hasSession ? 'confirm-and-reopen' : 'close-panel'
}

/** An aborted upload request is still owned by the cancellation operation until its DELETE settles. */
export function shouldRetainUploadActivityAfterRunFailure(cancelIntent: boolean): boolean {
  return cancelIntent
}
