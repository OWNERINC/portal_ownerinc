/** EXPERIMENTAL fixture, not shipped: requires Navigation.currentEntry support.
 * Capture native same-document traversals before the router observes popstate.
 * No navigate cancellation, synthetic events, history entries or framework state.
 * The caller owns dirty/pending values; ACK never automatically replays a block.
 */
type Entry = { index: number; key: string }
type NavigationWindow = Window & { navigation?: EventTarget & { currentEntry: Entry | null } }
type Listeners = { capture?: (event: PopStateEvent) => void; observe?: (event: Event) => void }
const coordinators = new WeakMap<Window, Listeners>()
/** Provider module initializes before router effects. Dispatcher owns no form data;
 * a mounted workspace registers/clears its callbacks for the document lifetime. */
export function initializePollHistory(target: Window = window) {
  const existing = coordinators.get(target)
  if (existing) return existing
  const listeners: Listeners = {}
  target.addEventListener('popstate', event => listeners.capture?.(event), true)
  ;(target as NavigationWindow).navigation?.addEventListener('navigate', event => listeners.observe?.(event))
  coordinators.set(target, listeners)
  return listeners
}
export function watchPollHistory(read: () => { dirty: boolean; pending: boolean }, target: Window = window) {
  const listeners = initializePollHistory(target)
  const navigation = (target as NavigationWindow).navigation
  if (!navigation?.currentEntry) return () => {}
  let origin = { index: navigation.currentEntry.index, key: navigation.currentEntry.key }
  let restoring = false, permit: number | null = null, destination: number | null = null
  let blocked = false, stopped = false
  // Entry objects become disposed on native replaceState. Snapshot primitive values
  // at the traversal boundary, after Next has finished push/replace for this route.
  const observe = (event: Event) => {
    if ((event as Event & { navigationType: string }).navigationType !== 'traverse' || restoring || permit !== null) return
    const entry = navigation.currentEntry
    if (entry) origin = { index: entry.index, key: entry.key }
  }
  const restore = () => {
    const current = navigation?.currentEntry
    if (current && current.index !== origin.index) target.history.go(origin.index - current.index)
  }
  const capture = (event: PopStateEvent) => {
    if (stopped) return
    const current = navigation?.currentEntry
    if (!current) return
    if (permit === current.index) { permit = null; return }
    const state = read()
    if (!restoring && !state.dirty && !state.pending) return
    event.stopImmediatePropagation()
    if (restoring) {
      if (current.key !== origin.key) { restore(); return }
      restoring = false
      const next = destination; destination = null
      // A traversal that began pending stays blocked even if ACK raced restoration.
      if (blocked || state.pending || next === null) return
      if (!state.dirty || target.confirm('Há alterações não salvas. Descartar as alterações?')) {
        permit = next
        target.history.go(next - origin.index)
      }
      return
    }
    destination = current.index; blocked = state.pending; restoring = true
    restore()
  }
  listeners.capture = capture; listeners.observe = observe
  return () => {
    stopped = true
    if (listeners.capture === capture) { listeners.capture = undefined; listeners.observe = undefined }
  }
}
