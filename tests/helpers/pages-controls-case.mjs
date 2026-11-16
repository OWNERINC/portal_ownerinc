export function selectControlsCase(argv = process.argv.slice(2), env = process.env) {
  const selected = argv[0] ?? env.PAGES_CONTROLS_CASE ?? 'menus';
  const cases = ['menus', 'structure', 'save', 'review', 'overlays', 'responsive', 'text-video', 'inspector', 'acceptance'];
  if (!cases.includes(selected)) throw new Error(`Invalid Pages controls case: ${JSON.stringify(selected)}. Expected one of: ${cases.join(', ')}`);
  return selected;
}
