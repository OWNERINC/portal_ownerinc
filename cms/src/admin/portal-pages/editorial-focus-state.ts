export type EditorialFocusable = { focus(): void }
export type EditorialValidationFields = Record<string, { valid?: boolean }>

type FocusTarget = () => EditorialFocusable | null

/** A path-aware registry; invalid paths are visited in Payload FormState order. */
export function createEditorialFieldFocusRegistry() {
  const targets = new Map<string, FocusTarget>()

  return {
    register(path: string, target: FocusTarget): () => void {
      const registration = target
      targets.set(path, registration)
      return () => {
        if (targets.get(path) === registration) targets.delete(path)
      }
    },

    focusFirstInvalid(fields: EditorialValidationFields): string | null {
      for (const [path, state] of Object.entries(fields)) {
        if (state?.valid !== false) continue
        const target = targets.get(path)?.()
        if (!target) continue
        target.focus()
        return path
      }
      return null
    },
  }
}

export type EditorialFieldFocusRegistry = ReturnType<typeof createEditorialFieldFocusRegistry>

const registries = new WeakMap<object, EditorialFieldFocusRegistry>()

/** Keep targets isolated to Payload's document form, including nested block forms. */
export function editorialFieldFocusRegistryFor(documentForm: object): EditorialFieldFocusRegistry {
  let registry = registries.get(documentForm)
  if (!registry) {
    registry = createEditorialFieldFocusRegistry()
    registries.set(documentForm, registry)
  }
  return registry
}
