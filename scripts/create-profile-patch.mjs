/** Generate a loader overlay from a resolved DSH profile without editing that profile. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

const agentIds = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code'];
const managedNames = new Set(agentIds.map(id => `dsh-context-${id}`));
const nativeEngine = '@deepseek-ai/dsh-compaction-basic';
const nativePruner = '@deepseek-ai/dsh-compaction-tool-result-pruner';
const presetName = '@deepseek-ai/dsh-agent-preset';
const rootGroupId = 'context-zoo';

const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  identify: value => isRecord(value) && typeof value.__jsExpr === 'string' && Object.keys(value).length === 1,
  resolve: value => ({ __jsExpr: value }),
  stringify: item => JSON.stringify(item.value.__jsExpr),
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRows(rows) {
  if (!Array.isArray(rows) || !rows.every(isRecord)) throw new Error('Expected a resolved DSH profile entry list');
}

/** Parse a DSH config dump while preserving its unevaluated !!js expressions. */
export function parseProfileDump(source) {
  const entries = parse(source, { customTags: [jsTag] });
  assertRows(entries);
  return entries;
}

/** Print a loader overlay using DSH's !!js YAML tag for preserved expressions. */
export function stringifyProfilePatch(patches) {
  return stringify(patches, { customTags: [jsTag], lineWidth: 0 });
}

function isEngine(entry) {
  return entry.name === nativeEngine || managedNames.has(entry.name);
}

function activeEngine(entry) {
  if (!isEngine(entry) || entry.disabled === true) return false;
  if (entry.disabled !== undefined && entry.disabled !== null && entry.disabled !== false) {
    throw new Error(`Cannot select a conditionally disabled context engine: ${entry.id ?? entry.name}`);
  }
  return true;
}

function requireId(entry) {
  if (typeof entry.id !== 'string' || entry.id.length === 0) throw new Error(`The profile entry needs an id: ${entry.name}`);
  return entry.id;
}

function replaceEngine(entry, packageName) {
  return { ...entry, name: packageName, config: entry.name === nativeEngine ? {} : (entry.config ?? {}) };
}

/** Resolve the compaction realms declared by groups; ordinary groups share their parent's services. */
function inspectComposition(entries) {
  const rootRealm = {};
  const namedRealms = new Map();
  const engineRealms = new Map();
  const engines = new Set();
  const pruners = new Map();
  const rootIds = new Set();
  const checkIds = (rows, ids) => {
    assertRows(rows);
    for (const entry of rows) {
      if (entry.id !== undefined) {
        if (ids.has(entry.id)) throw new Error(`Duplicate loader entry id: ${entry.id}`);
        ids.add(entry.id);
      }
      if (entry.group === true && Array.isArray(entry.config)) checkIds(entry.config, ids);
      if (entry.name === presetName && isRecord(entry.config)) checkIds(entry.config.plugins, new Set());
    }
  };
  checkIds(entries, rootIds);
  const visit = (rows, parentRealm, conditional = false, inPreset = false) => {
    for (const entry of rows) {
      if (entry.disabled === true) continue;
      let realm = parentRealm;
      const label = entry.isolate?.compaction;
      if (label === true) realm = {};
      else if (typeof label === 'string' && label.length > 0) {
        if (!namedRealms.has(label)) namedRealms.set(label, {});
        realm = namedRealms.get(label);
      } else if (label !== undefined) throw new Error(`Invalid compaction isolation on ${entry.id ?? entry.name}`);
      const uncertain = conditional || (entry.disabled !== undefined && entry.disabled !== null && entry.disabled !== false);
      if (activeEngine(entry)) {
        if (uncertain) throw new Error(`Cannot replace a context engine under a conditionally disabled entry: ${entry.id ?? entry.name}`);
        if (inPreset && realm === rootRealm) throw new Error(`Preset context engines require compaction isolation: ${entry.id ?? entry.name}`);
        if (engineRealms.has(realm)) throw new Error('A compaction realm contains more than one active compaction engine');
        engineRealms.set(realm, entry);
        engines.add(entry);
      }
      if (entry.name === nativePruner) pruners.set(entry, realm);
      if (entry.group === true && Array.isArray(entry.config)) visit(entry.config, realm, uncertain, inPreset);
      // The registry mounts each preset from its host owner; a declaration's local services are not inherited.
      if (entry.name === presetName && isRecord(entry.config)) visit(entry.config.plugins, rootRealm, uncertain, true);
    }
  };
  visit(entries, rootRealm);
  return { engines, pruners: new Set([...pruners].filter(([, realm]) => engineRealms.has(realm)).map(([entry]) => entry)), rootIds };
}

/**
 * Replace active native or zoo engines in a resolved profile and preserve every other setting.
 * Group and preset config overrides contain their full original config because DSH replaces it.
 * @param entries - The entry list printed by dsh --dump-config.
 * @param agentId - One of the seven context strategy ids.
 * @returns A loader patch list to apply after the profile's existing layers.
 */
export function createProfilePatch(entries, agentId) {
  assertRows(entries);
  if (!agentIds.includes(agentId)) throw new Error(`Unknown context strategy ${JSON.stringify(agentId)}; choose ${agentIds.join(', ')}`);
  const packageName = `dsh-context-${agentId}`;
  const copied = structuredClone(entries);
  const { engines, pruners, rootIds } = inspectComposition(copied);
  let changes = 0;

  const rewriteRows = (rows) => {
    assertRows(rows);
    return rows.map(entry => {
      if (entry.disabled === true) return entry;
      if (engines.has(entry)) {
        changes++;
        return replaceEngine(entry, packageName);
      }
      if (pruners.has(entry)) { changes++; return { ...entry, disabled: true }; }
      if (entry.group === true && Array.isArray(entry.config)) return { ...entry, config: rewriteRows(entry.config) };
      if (entry.name === presetName && isRecord(entry.config)) {
        return { ...entry, config: { ...entry.config, plugins: rewriteRows(entry.config.plugins) } };
      }
      return entry;
    });
  };

  const patches = [];
  const direct = copied.filter(entry => engines.has(entry));
  if (direct.length > 1) throw new Error('Replacing multiple separately isolated host engines requires a group configuration');
  for (const entry of copied) {
    if (entry.disabled === true) continue;
    if (engines.has(entry)) {
      patches.push({ id: requireId(entry), name: entry.name, disabled: true });
      continue;
    }
    if (pruners.has(entry)) {
      patches.push({ id: requireId(entry), name: entry.name, disabled: true });
      continue;
    }
    const before = changes;
    let config;
    if (entry.group === true && Array.isArray(entry.config)) config = rewriteRows(entry.config);
    else if (entry.name === presetName && isRecord(entry.config)) {
      config = { ...entry.config, plugins: rewriteRows(entry.config.plugins) };
    }
    if (changes !== before) patches.push({ id: requireId(entry), name: entry.name, config });
  }
  if (direct.length > 0) {
    for (const id of [rootGroupId, 'context-zoo-engine']) {
      if (rootIds.has(id)) throw new Error(`Cannot insert context engine: profile id ${id} is already in use`);
    }
    patches.push({ insert: [{
      id: rootGroupId,
      name: 'cordis:group',
      group: true,
      config: [{ ...replaceEngine(direct[0], packageName), id: 'context-zoo-engine' }],
    }] });
  }
  if (engines.size === 0) throw new Error('No active native or zoo compaction engine was found in the resolved profile');
  return patches;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [agentId, filename, ...extra] = process.argv.slice(2);
    if (!agentId || !filename || extra.length > 0) throw new Error('Usage: node scripts/create-profile-patch.mjs <agent-id> <resolved-profile.yml>');
    process.stdout.write(stringifyProfilePatch(createProfilePatch(parseProfileDump(readFileSync(filename, 'utf8')), agentId)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
