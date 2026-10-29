import { access, cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'src');
const outputDir = path.join(root, 'dist');
const scripts = (await readdir(sourceDir)).filter((name) => name.endsWith('.js'));

for (const file of [...scripts.map((name) => path.join(sourceDir, name)), path.join(root, 'functions/song-admin/src/main.js')]) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`JavaScript syntax check failed: ${path.relative(root, file)}`);
}

const html = await readFile(path.join(root, 'index.html'), 'utf8');
for (const [, relativePath] of html.matchAll(/\b(?:src|href)="((?:src|assets)\/[^"?#]+)"/g)) {
  await access(path.join(root, relativePath));
}

await mkdir(outputDir, { recursive: true });
await cp(path.join(root, 'index.html'), path.join(outputDir, 'index.html'));
await cp(sourceDir, path.join(outputDir, 'src'), { recursive: true, force: true });
await cp(path.join(root, 'assets'), path.join(outputDir, 'assets'), { recursive: true, force: true });
console.log('Static site built in dist/');
