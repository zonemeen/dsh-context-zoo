import { readdir, rm } from 'node:fs/promises';
const packages = new URL('../packages/', import.meta.url);
for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (entry.isDirectory()) await rm(new URL(`${entry.name}/dist/`, packages), { recursive: true, force: true });
}
