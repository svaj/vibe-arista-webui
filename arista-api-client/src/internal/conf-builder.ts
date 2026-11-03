/**
 * Building a `Node` (or a bare `Transport`) from connection options or from a profile —
 * M3 (#5), the code behind `createConnection` / `createNode` / `createNodeFor`.
 *
 * It lives here, in `src/internal/`, and takes the **entry point as an argument** so both entries
 * share one implementation without either importing the other (DR-002):
 *  - `src/index.ts` passes the browser `createTransport` (`transports/create.ts`) — `https`/`http`
 *    only, no TLS trust, no local kinds (DR-008/DR-013);
 *  - `src/node.ts` passes `createNodeTransport` (`transports/node-create.ts`), which can also build
 *    `session`, `https-client-cert`, `unix` and `http-local`.
 *
 * Same-name factories, different reach — which is what lets a profile that says `transport = https`
 * keep working from either entry (MIGRATION.md §5 row 28) while a profile that says `socket` fails
 * loudly in the browser build with a message naming the import that would work.
 *
 * pyeapi's `connect()`/`connect_to()` (`client.py:394-461`, `:1040-1067`) are **not** copied
 * structurally: they take positional-or-kwargs and forward everything into a connection constructor.
 * Here the option record is validated first, and the `Node` settings are a separate bag
 * ({@link NodeSettings}), because pyeapi's `**kwargs` mixing is MIGRATION.md §5 row 31's bug —
 * `Node(connection, stop_on_error=False)` silently changes nothing on the wire.
 */

import { Node } from '../command-layer'
import { NotSupportedError } from '../errors'
import { DEFAULT_LOCAL_CONNECTION_NAME, profileNodeSettings, profileToTransportOptions, type ConnectionProfile, type ProfileEntry, type ProfileFields, type ProfileStore } from '../profiles'
import type { NodeSettings } from '../command-layer'
import type { Transport, TransportOptions } from '../transports/contract'

/** How this module builds a transport: the calling entry point's own factory (DR-002). */
export type TransportFactory = (options: TransportOptions) => Transport

/**
 * The option bag `createConnection`/`createNode` accept — connection options plus per-`Node` settings,
 * as one flat record. pyeapi splits the same information across `connect()`'s named parameters and the
 * `**kwargs` that land in `Node.__init__` (`client.py:453-460`); one flat bag with a `never`-typed
 * option table keeps the two sets from being confused for each other.
 */
export type ConnectionOptions = TransportOptions & NodeSettings

/** The name-based form: pyeapi's `connect_to(name)` (`client.py:1040-1067`). */
export interface ProfileConnectionOptions extends NodeSettings {
  /** Look this connection up in `store`. pyeapi reads a module-global `config` instead (`client.py:318`). */
  readonly profileName: string
  readonly store: ProfileStore
  /** Per-call overrides for the profile's own fields (DR-008's local gate, a one-off host). */
  readonly overrides?: ProfileFields | undefined
  /**
   * Allow pyeapi's implicit `[connection:localhost] transport = socket` to be added when the store has
   * no `localhost` (`client.py:214-221`). Node only — DR-008, MIGRATION.md §5 row 55.
   */
  readonly implicitLocalhost?: boolean | undefined
}

/**
 * The profile-**object** form: a {@link ConnectionProfile} the caller already holds — from
 * {@link createProfiles} (application config) or from a parsed file it fetched itself. It is the form
 * `src/index.ts`'s own doc block promised (`createNode({ profile: store.get('lab')! })`), which the
 * checkpoint's union did not actually accept, and without it a browser app would have to reach into
 * `connectionFromProfile`/`nodeFromProfile` by hand even though `createNode` is the documented entry.
 */
export interface ProfileObjectOptions extends NodeSettings {
  readonly profile: ConnectionProfile
  /** Per-call overrides for the profile's own fields (DR-008's local gate, a one-off host). */
  readonly overrides?: ProfileFields | undefined
}

/** A bag never mixes forms: the key naming the profile decides which of the three it is. */
export type NodeFactoryOptions = ConnectionOptions | ProfileConnectionOptions | ProfileObjectOptions

/** The `Node`-setting keys, i.e. the half of a bag that must never reach a transport factory. */
const NODE_SETTING_KEYS: readonly (keyof NodeSettings)[] = ['enablePassword', 'autorefresh', 'configDefaults']

/** Unknown-key discipline for the profile forms — `NodeSettings` is closed, but JS callers are not. */
const PROFILE_NAME_FORM_KEYS: readonly string[] = ['profileName', 'store', 'overrides', 'enablePassword', 'autorefresh', 'configDefaults', 'implicitLocalhost']
const PROFILE_OBJECT_FORM_KEYS: readonly string[] = ['profile', 'overrides', 'enablePassword', 'autorefresh', 'configDefaults']

export function isProfileNameForm(options: NodeFactoryOptions): options is ProfileConnectionOptions {
  return 'profileName' in options
}

export function isProfileObjectForm(options: NodeFactoryOptions): options is ProfileObjectOptions {
  return 'profile' in options
}

function isNodeSettingKey(key: string): boolean {
  return NODE_SETTING_KEYS.includes(key as keyof NodeSettings)
}

function splitSettings(options: Partial<NodeSettings>): NodeSettings {
  return {
    ...(options.enablePassword === undefined ? {} : { enablePassword: options.enablePassword }),
    ...(options.autorefresh === undefined ? {} : { autorefresh: options.autorefresh }),
    ...(options.configDefaults === undefined ? {} : { configDefaults: options.configDefaults }),
  }
}

/**
 * The transport half of a combined bag: everything except the {@link NodeSettings} keys.
 *
 * Dropping them is not cosmetic. `createTransport` runs every key through the DR-016 allow-list
 * (`transports/create.ts` → `assertOptionKeys`), which refuses `enablePassword`/`autorefresh`/
 * `configDefaults` as "unsupported option for transport kind". The checkpoint handed the **combined**
 * `ConnectionOptions` bag straight to the factory, so `createNode({ kind: 'https', host, enablePassword })`
 * threw on every call that tried to set an enable password — i.e. pyeapi's
 * `connect(..., enablepwd='enablepwd', return_node=True)` case (`client.py:453-460`, `:504`, asserted
 * by upstream's `test_connect_return_node_enablepwd`) was impossible through this entry.
 *
 * The generic keeps the caller's own discriminant (`kind`) so the result still satisfies the
 * {@link TransportOptions} union; `Omit<T, …>` over a union would collapse the members and stop
 * typechecking. The cost is that the returned type still *mentions* the settings keys it removed at
 * runtime, so nothing downstream can read them by accident — only the `Node` built beside it does, via
 * {@link splitSettings}. A `Record<string, unknown>` intermediate is not available here: an interface
 * has no index signature to assert to (that is what TS2352 refused in the checkpoint).
 */
function withoutNodeSettings<T extends object>(options: T): T {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (isNodeSettingKey(key)) continue
    rest[key] = value
  }
  return rest as T
}

/** A profile-form bag that carries an unexpected key is refused rather than ignored (row 31's lesson). */
function assertProfileFormKeys(options: object, accepted: readonly string[], form: string): void {
  const unknown = Object.keys(options).filter((key) => !accepted.includes(key))
  if (unknown.length === 0) return
  throw new NotSupportedError(
    `unknown option(s) ${unknown.join(', ')} on the ${form} createNode/createConnection call. ` +
      `The ${form} takes ${accepted.join(', ')}; ` +
      'connection options belong on the explicit kind: form (MIGRATION.md §5 row 31: an option that silently does nothing is worse than one that fails)',
    { commands: [] },
  )
}

/**
 * pyeapi `connect_to(name)` raises `AttributeError('connection profile not found in config')`
 * (`client.py:1061-1064`, asserted by upstream's `test_missing_connection_raises_attribute_error`).
 * Here it is an `EapiError` subtype the UI can branch on, naming the profile and what *is* known.
 * The password is not in `store.toString()` either — that method lists names only (DR-011, row 54).
 */
export function profileNotFound(name: string, store: ProfileStore): NotSupportedError {
  const known = store.names()
  return new NotSupportedError(
    `connection profile ${JSON.stringify(name)} is not defined. Known profiles: ${known.length === 0 ? 'none' : known.join(', ')} (pyeapi raises AttributeError here — client.py:1061-1064)`,
    { commands: [] },
  )
}

/** Transport options plus `Node` settings for one resolved profile, shared by both profile forms. */
function transportAndSettingsFor(
  profile: ConnectionProfile,
  options: { readonly overrides?: ProfileFields | undefined } & Partial<NodeSettings>,
  entry: ProfileEntry,
): { transportOptions: TransportOptions; settings: NodeSettings } {
  return {
    transportOptions: profileToTransportOptions(profile, {
      entry,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    }),
    // pyeapi folds `enablepwd` into the Node (`client.py:1066` → `client.py:504`); an explicit
    // `enablePassword` in the call wins, because the caller is the one holding the secret.
    settings: { ...profileNodeSettings(profile), ...splitSettings(options) },
  }
}

/** One profile-**name** bag → transport options, with pyeapi's implicit-`localhost` store rule applied. */
function optionsFromProfileName(
  options: ProfileConnectionOptions,
  entry: ProfileEntry,
): { transportOptions: TransportOptions; settings: NodeSettings } {
  const { store, profileName, implicitLocalhost } = options
  if (implicitLocalhost ?? entry === 'node') {
    // `_add_default_connection` again, so `createNodeFor('localhost')` works from a bare store too —
    // Node only, and still inert until `allowLocalUnauthenticated` is stated (DR-008, row 55).
    if (!store.has(DEFAULT_LOCAL_CONNECTION_NAME)) store.addDefaultLocalConnection()
  }
  const profile = store.get(profileName)
  if (profile === undefined) throw profileNotFound(profileName, store)
  return transportAndSettingsFor(profile, options, entry)
}

function assertNameForm(options: ProfileConnectionOptions): void {
  assertProfileFormKeys(options, PROFILE_NAME_FORM_KEYS, 'profileName form')
}

function assertObjectForm(options: ProfileObjectOptions): void {
  assertProfileFormKeys(options, PROFILE_OBJECT_FORM_KEYS, 'profile object form')
}

/**
 * The pyeapi `connect()` equivalent, entry-parameterised (DR-044/DR-046): this is what both
 * `createConnection` functions do, and it returns a {@link Transport} rather than pyeapi's
 * `EapiConnection`, because M2's `Transport` already carries kind + address + the secret-free
 * `toString()` a UI needs (DR-002).
 */
export function connectionFromOptions(options: NodeFactoryOptions, factory: TransportFactory, entry: ProfileEntry): Transport {
  if (isProfileNameForm(options)) {
    assertNameForm(options)
    return factory(optionsFromProfileName(options, entry).transportOptions)
  }
  if (isProfileObjectForm(options)) {
    assertObjectForm(options)
    return factory(transportAndSettingsFor(options.profile, options, entry).transportOptions)
  }
  return factory(withoutNodeSettings(options))
}

/** The pyeapi `connect(..., return_node=True)` equivalent (DR-005: no `return_node` flag — pick the function). */
export function nodeFromOptions(options: NodeFactoryOptions, factory: TransportFactory, entry: ProfileEntry): Node {
  if (isProfileNameForm(options)) {
    assertNameForm(options)
    const { transportOptions, settings } = optionsFromProfileName(options, entry)
    return new Node(factory(transportOptions), settings)
  }
  if (isProfileObjectForm(options)) {
    assertObjectForm(options)
    const { transportOptions, settings } = transportAndSettingsFor(options.profile, options, entry)
    return new Node(factory(transportOptions), settings)
  }
  // The transport factory sees only the connection half (see {@link withoutNodeSettings}).
  return new Node(factory(withoutNodeSettings(options)), splitSettings(options))
}

/**
 * `createNodeFor(name)`'s shared body: settings come from the profile (`enablepwd`) unless the caller
 * passed them, and the transport from the resolved entry's factory.
 */
export function nodeFromProfileStore(options: ProfileConnectionOptions, factory: TransportFactory, entry: ProfileEntry): Node {
  assertNameForm(options)
  const { transportOptions, settings } = optionsFromProfileName(options, entry)
  return new Node(factory(transportOptions), settings)
}

/** `createConnection` for a profile name: the transport only, no command layer (pyeapi's `connect_to` minus `return_node`). */
export function connectionFromProfileStore(options: ProfileConnectionOptions, factory: TransportFactory, entry: ProfileEntry): Transport {
  assertNameForm(options)
  return factory(optionsFromProfileName(options, entry).transportOptions)
}

/** The transport behind a `ConnectionProfile` from app config — pyeapi's `connect(**config_for(name))`, file-free (DR-038). */
export function connectionFromProfile(
  profile: ConnectionProfile,
  factory: TransportFactory,
  entry: ProfileEntry,
  overrides?: ProfileFields | undefined,
): Transport {
  return factory(
    profileToTransportOptions(profile, {
      entry,
      ...(overrides === undefined ? {} : { overrides }),
    }),
  )
}

/** The `Node` for that same profile: the profile's `enablepwd` merged with the caller's settings. */
export function nodeFromProfile(
  profile: ConnectionProfile,
  settings: NodeSettings,
  factory: TransportFactory,
  entry: ProfileEntry,
  overrides?: ProfileFields | undefined,
): Node {
  return new Node(connectionFromProfile(profile, factory, entry, overrides), {
    ...profileNodeSettings(profile),
    ...splitSettings(settings),
  })
}
