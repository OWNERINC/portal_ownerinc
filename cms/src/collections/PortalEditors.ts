import type { CollectionConfig } from 'payload'

// Locked identity projection until the Portal-backed strategy is introduced in Task 3.
export const PortalEditors: CollectionConfig = {
  slug: 'portal-editors',
  auth: { disableLocalStrategy: true },
  access: {
    admin: () => false,
    create: () => false,
    read: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [],
}
