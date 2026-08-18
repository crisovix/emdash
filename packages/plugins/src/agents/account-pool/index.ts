/**
 * The Account Pool's public surface: the account list, where the auto router
 * records its bindings, and how to read them. Exposed so the desktop app can
 * report on the pool without reaching into plugin internals or re-implementing
 * the log format.
 */
export { poolAccountProfiles } from './profiles';
export { defaultRoutingStorePath, readRoutingBindings } from './routing-store';
