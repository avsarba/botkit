/**
 * A deterministic, in-memory fleet of services for the Ops Desk example.
 * Nothing here talks to a real system: a deploy bumps a version string and an outage is a flag.
 * Every call to createFleet() starts from the same state, so tests and demos are repeatable.
 */

const INITIAL_SERVICES = [
    { name: 'api', staging: '2.3.1', production: '2.3.0' },
    { name: 'billing', staging: '1.4.2', production: '1.4.1' },
    { name: 'search', staging: '0.9.8', production: '0.9.8' }
];

const ENVIRONMENTS = ['staging', 'production'];

/**
 * '1.4.2' -> '1.4.3'
 */
function bumpPatch(version) {
    const parts = version.split('.');
    const last = parts.length - 1;
    parts[last] = String(parseInt(parts[last], 10) + 1);
    return parts.join('.');
}

/**
 * Format rows as columns separated by two spaces, without trailing spaces.
 */
function formatColumns(rows) {
    const widths = rows[0].map((cell, column) => Math.max(...rows.map((row) => row[column].length)));
    return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').replace(/\s+$/, '')).join('\n');
}

/**
 * Create a fleet with three services: api, billing and search, all healthy.
 *
 * ```javascript
 * const fleet = createFleet();
 * fleet.deploy('billing', 'production'); // '1.4.2'
 * console.log(fleet.table());
 * ```
 *
 * @returns {{
 *   names: () => string[],
 *   status: () => { name: string, staging: string, production: string, healthy: boolean }[],
 *   table: () => string,
 *   deploy: (name: string, env: 'staging' | 'production') => string,
 *   setHealthy: (name: string, healthy: boolean) => void,
 *   audit: { service: string, env: string, version: string, user: string, at: string }[]
 * }}
 */
module.exports = function createFleet() {
    const services = INITIAL_SERVICES.map((service) => ({ ...service, healthy: true }));

    function find(name) {
        const service = services.find((s) => s.name === name);
        if (!service) {
            throw new Error(`Unknown service "${ name }"`);
        }
        return service;
    }

    return {
        /**
         * The service names, in a fixed order.
         */
        names() {
            return services.map((service) => service.name);
        },

        /**
         * A copy of every service's versions and health.
         */
        status() {
            return services.map((service) => ({
                name: service.name,
                staging: service.staging,
                production: service.production,
                healthy: service.healthy
            }));
        },

        /**
         * The status as a text table: a header, then one row per service.
         */
        table() {
            const rows = [['SERVICE', 'STAGING', 'PRODUCTION', 'HEALTH']].concat(services.map((service) => [
                service.name,
                service.staging,
                service.production,
                service.healthy ? 'healthy' : 'UNHEALTHY'
            ]));
            return formatColumns(rows);
        },

        /**
         * Deploy a service. Staging gets a new patch version; production gets the version that is on staging.
         * @returns The version now running in that environment.
         */
        deploy(name, env) {
            const service = find(name);
            if (!ENVIRONMENTS.includes(env)) {
                throw new Error(`Unknown environment "${ env }"`);
            }
            if (env === 'staging') {
                service.staging = bumpPatch(service.staging);
            } else {
                service.production = service.staging;
            }
            return service[env];
        },

        /**
         * Simulate an outage (false) or a recovery (true).
         */
        setHealthy(name, healthy) {
            find(name).healthy = !!healthy;
        },

        /**
         * Completed deploys, oldest first. The deploy feature appends to it.
         */
        audit: []
    };
};
