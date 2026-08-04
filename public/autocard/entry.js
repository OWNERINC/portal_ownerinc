import { requireAutoCard } from './guard.js';

if (await requireAutoCard()) {
  await import('./app.js');
  await import('./vacancy-enhancements.js');
  await import('./variant-enhancements.js');
}
