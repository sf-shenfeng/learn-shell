// Registers ./esm-ext-hooks.mjs as a Node module customization hook.
// Passed to `node --import` from the "start" script so it's active before
// dist/index.js (and anything it imports) is loaded.
import { register } from 'node:module';

register('./esm-ext-hooks.mjs', import.meta.url);
