import { mount as mountEditor } from './app.js';
import { mount as mountVacancy } from './vacancy-enhancements.js';
import { mount as mountVariants } from './variant-enhancements.js';

export function mount(page) {
  mountEditor(page);
  mountVacancy(page);
  mountVariants(page);
}
