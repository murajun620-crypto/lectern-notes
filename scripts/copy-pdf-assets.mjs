import { cp, mkdir } from 'node:fs/promises';
await mkdir('public', { recursive: true });
for (const folder of ['cmaps', 'standard_fonts'])
  await cp(`node_modules/pdfjs-dist/${folder}`, `public/${folder}`, { recursive: true });
