/**
 * The Account Pool's public surface: the account list, and where the auto
 * router records its bindings. Exposed so the desktop app can report on the pool
 * without reaching into plugin internals.
 */
export { poolAccountProfiles } from './profiles';
export { defaultRoutingStorePath } from './routing-store';
