// Orbit storage-mode resolver — phase 1.
//
// Deliberately NOT imported by worker/index.js. It exists so a future commit can
// switch one feature at a time from its current storage to the object model
// without a global flag or a silent authority change.
//
// Contract:
//   resolveStorageMode(env, feature) -> 'legacy' | 'shadow' | 'objects'
//   - missing flag, unknown flag, unknown feature, or missing D1 binding -> 'legacy'
//   - never throws
//   - 'shadow' and 'objects' require env.ORBIT_OBJECTS_DB
//
// Flag name: ORBIT_STORAGE_<FEATURE>  (e.g. ORBIT_STORAGE_INBOX=shadow)

export const STORAGE_MODES = Object.freeze(['legacy', 'shadow', 'objects']);

const FEATURE_RE = /^[a-z][a-z0-9_]*$/i;

export function storageFlagName(feature) {
  const key = String(feature ?? '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return key ? `ORBIT_STORAGE_${key}` : null;
}

export function resolveStorageMode(env, feature) {
  try {
    if (!env || typeof env !== 'object') return 'legacy';
    if (typeof feature !== 'string' || !FEATURE_RE.test(feature)) return 'legacy';

    const flag = storageFlagName(feature);
    if (!flag) return 'legacy';

    const raw = env[flag];
    if (typeof raw !== 'string') return 'legacy';

    const mode = raw.trim().toLowerCase();
    if (!STORAGE_MODES.includes(mode)) return 'legacy';
    if (mode === 'legacy') return 'legacy';

    // Any non-legacy mode needs the binding; otherwise fall back rather than fail.
    return env.ORBIT_OBJECTS_DB ? mode : 'legacy';
  } catch {
    return 'legacy';
  }
}

export function storageSummary(env, features = []) {
  const out = {};
  for (const feature of features) out[feature] = resolveStorageMode(env, feature);
  return out;
}
