// Driver for the markdown-render-speed entry. The harness runs
// `node /bot/main.ts` (node22). It reads every case from /input/cases.json
// (a JSON array of {id, markdown}), renders each one alone with parse() from
// parse.js, and writes /output/html.json: a JSON array of the HTML strings,
// one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
// Written by hand for this entry (not copied from the baseline).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];

// Render each case in order into a pre-sized array, then write the whole
// result as one JSON document. The output directory may not exist yet in
// the harness sandbox, so create it first.
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
