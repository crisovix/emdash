import path from 'node:path';
import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';

/**
 * A view of `fs` whose paths resolve under `prefix`. The mcp and trust helpers
 * bake in home-relative config names (`.claude.json`) and receive a home-rooted
 * fs from their callers, so re-rooting an account's config has to happen at the
 * fs, not at the config name. Prefixing rather than constructing a new local fs
 * keeps the caller's implementation and its root jail intact.
 */
export function prefixedFs(fs: PluginFs, prefix: string): PluginFs {
  const at = (p: string): string => path.join(prefix, p);
  return {
    read: (p) => fs.read(at(p)),
    write: (p, content) => fs.write(at(p), content),
    delete: (p) => fs.delete(at(p)),
    exists: (p) => fs.exists(at(p)),
    list: (p) => fs.list(at(p)),
  };
}

/**
 * Path of `dir` relative to `homeDir`, or null when `dir` is not under it.
 * Null means the account's config cannot be reached through the home-rooted fs
 * callers pass, so the fs-backed capabilities must stay off for it rather than
 * resolve to the wrong account's config.
 */
export function relativeToHome(homeDir: string, dir: string): string | null {
  const rel = path.relative(homeDir, dir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}
