/** Include the profile generator and host compatibility files in the core package. */
import { chmod, copyFile, cp, mkdir } from 'node:fs/promises';
const target = new URL('../packages/core/dist/', import.meta.url);
await mkdir(new URL('tools/', target), { recursive: true });
await copyFile(new URL('create-profile-patch.mjs', import.meta.url), new URL('tools/create-profile-patch.mjs', target));
await chmod(new URL('tools/create-profile-patch.mjs', target), 0o755);
await cp(new URL('../patches/', import.meta.url), new URL('compat/', target), { recursive: true });
