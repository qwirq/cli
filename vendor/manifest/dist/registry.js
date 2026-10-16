import { isPipelineOnly } from './validate.js';
/** The MF container name for an app_id. The container is declared as a JS var, so it cannot contain
 *  hyphens; hosts derive the remote name from app_id the same way. app_id stays kebab in the registry;
 *  only the runtime container identifier is sanitized. */
export function containerName(appId) {
    return appId.replace(/[^a-zA-Z0-9_]/g, '_');
}
/** Map a parsed manifest + build outputs into the instance_apps registry shape. Throws for a
 *  pipeline-only manifest: it provides nothing to an instance, so it never becomes an app. */
export function manifestToInstanceApp(m, opts) {
    if (isPipelineOnly(m)) {
        throw new Error(`qwirq.yaml: "${m.id}" is pipeline-only (no provides); it is not an app and has no instance registration`);
    }
    return {
        appId: m.id,
        title: m.name,
        href: `/a/${m.id}`,
        iconKey: m.icon ?? 'folder',
        order: m.nav?.order ?? 100,
        requires: m.requires,
        activeMatch: [`/a/${m.id}`],
        source: 'project',
        nav: m.nav?.hidden ? false : true,
        version: opts.version,
        entry: opts.entry,
        permissions: null,
        isolationTier: 'native',
        functions: opts.functions ?? null,
    };
}
