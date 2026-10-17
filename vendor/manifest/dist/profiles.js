/**
 * Network profiles a step can select, and the reviewed egress allowlist behind `dependencies`.
 * The manifest only NAMES a profile; it can never add a destination. This file is the reviewed
 * policy text the runner's proxy enforces (apps/runner, together with Docker/firewall isolation —
 * proxy variables alone are not a boundary). A change is a new `revision`, reviewed like code; the
 * engine records `egressPolicySha256()` with each check set. Sources: C12 (CT1 egress findings, CT2
 * Android probe), M3-6-SPEC §A.
 */
import { createHash } from 'node:crypto';
export const NETWORK_PROFILES = Object.freeze({
    none: Object.freeze({ services: false, egress: false }),
    services: Object.freeze({ services: true, egress: false }),
    dependencies: Object.freeze({ services: true, egress: true }),
});
const h = (host, why, status = 'reviewed') => Object.freeze({ host, ports: Object.freeze([443]), why, status });
/**
 * The `dependencies` profile. Exact hosts only; redirects to any other host fail closed as
 * dependency_host_denied. Private, link-local, loopback and metadata addresses, IP-literal CONNECT,
 * non-443 ports and DNS rebinding are denied by the proxy regardless of this list.
 */
export const DEPENDENCY_EGRESS_POLICY = Object.freeze({
    revision: 1,
    reviewed: '2026-10-17',
    hosts: Object.freeze([
        h('registry.npmjs.org', 'npm/pnpm packages from committed lockfiles (CT1 install, CT2 npm ci)'),
        h('repo.maven.apache.org', 'Maven Central (CT2 Gradle resolution)'),
        h('repo1.maven.org', 'Maven Central alternate host (CT2 Gradle resolution)'),
        h('maven.google.com', 'Google Maven: AndroidX/AGP artifacts (CT2)'),
        h('dl.google.com', 'Google Maven redirect target and SDK repository (CT2)'),
        h('plugins.gradle.org', 'Gradle plugin portal (CT2)'),
        h('plugins-artifacts.gradle.org', 'Gradle plugin portal artifact redirect target (CT2)'),
        h('jitpack.io', 'JitPack artifacts referenced by React Native modules (CT2)'),
        h('repo.reactnative.dev', 'React Native artifact repository (CT2)'),
        h('github.com', 'GitHub release assets fetched only as sha256-pinned build downloads (CT2 rn-audio-libs); mirror before M6'),
        h('objects.githubusercontent.com', 'GitHub release-asset redirect target (CT2); mirror before M6'),
        h('release-assets.githubusercontent.com', 'GitHub release-asset redirect target (CT2); mirror before M6'),
        h('fonts.googleapis.com', 'next/font/google CSS during the Chalk Tally web build (CT1 build-web)', 'temporary'),
        h('fonts.gstatic.com', 'next/font/google font files during the Chalk Tally web build (CT1 build-web)', 'temporary'),
        h('world.openfoodfacts.org', 'Chalk Tally e2e barcode lookup (apps/api/src/services/foods.ts) until a configurable stub lands (CT1 acceptance)', 'temporary'),
    ]),
});
/** The canonical digest of the egress policy (sorted keys), for check-set/policy identity. */
export function egressPolicySha256() {
    const canon = (v) => {
        if (v === null || typeof v !== 'object')
            return JSON.stringify(v);
        if (Array.isArray(v))
            return `[${v.map(canon).join(',')}]`;
        const o = v;
        return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
    };
    return createHash('sha256').update(canon(DEPENDENCY_EGRESS_POLICY)).digest('hex');
}
/** Whether a hostname is on the reviewed list (exact, case-insensitive). The proxy remains authoritative. */
export function isAllowedEgressHost(host) {
    const hn = host.toLowerCase();
    return DEPENDENCY_EGRESS_POLICY.hosts.some((e) => e.host === hn);
}
