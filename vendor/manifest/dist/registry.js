/** The MF container name for an app_id. The container is declared as a JS var, so it cannot contain
 *  hyphens; hosts derive the remote name from app_id the same way. app_id stays kebab in the registry;
 *  only the runtime container identifier is sanitized. */
export function containerName(appId) {
    return appId.replace(/[^a-zA-Z0-9_]/g, '_');
}
/** Map a parsed manifest + build outputs into the instance_apps registry shape. */
export function manifestToInstanceApp(m, opts) {
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
