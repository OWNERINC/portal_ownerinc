export function collectEditableFields(form) {
  return [...(form?.querySelectorAll('[data-field], [data-owner-field]') || [])].map(input => ({
    template: input.hasAttribute('data-owner-field') ? 'convite_owner' : 'convite_owntime',
    key: input.getAttribute('data-owner-field') || input.getAttribute('data-field'), inputId: input.id,
    label: [...(input.closest('label')?.childNodes || [])].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim(),
    multiline: input.tagName === 'TEXTAREA'
      || input.getAttribute('aria-multiline') === 'true'
      || input.dataset.multiline === 'true'
      || input.classList?.contains('is-multiline'),
    maxLength: input.maxLength > 0 ? input.maxLength : Number(input.dataset.maxlength) || null,
  }));
}
