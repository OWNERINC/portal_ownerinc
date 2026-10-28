import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const implementation = require('../../api/owner-news/cutover');
export const parseCutoverArguments = implementation.parseArguments;
export const runCutover = implementation.run;
