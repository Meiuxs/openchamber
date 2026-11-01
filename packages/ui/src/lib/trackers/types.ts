/**
 * The work-item tracker contract, as the server's tracker registry serves it
 * (`packages/web/server/lib/trackers/tracker-contract.d.ts` holds the same
 * shapes). Every tracker (Linear today) answers in these neutral shapes; what
 * is the provider's own stays in its server module.
 */

/** Open id, `^[a-z][a-z0-9-]{0,31}$`, in the namespace tracker and source-control ids share. */
export type TrackerProviderId = string;
export type TrackerStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type TrackerPerson = { name: string | null; avatarUrl: string | null };

export type TrackerItemState = { id: string | null; name: string; category: TrackerStateCategory | null };

export type TrackerContainer = { id: string; key: string | null; name: string };

export type TrackerLabel = { id: string; name: string; color: string | null };

/** Only the first few children are counted; `more` says there are others. */
export type TrackerProgress = { total: number; done: number; more: boolean };

export type TrackerItemSummary = {
  provider: TrackerProviderId;
  /** The provider's stable id (Linear UUID); what get and update take. */
  id: string;
  /** Human key, case-insensitive (ENG-12); the identity everywhere else. */
  identifier: string;
  title: string;
  url: string;
  state: TrackerItemState | null;
  priority?: TrackerPriority | null;
  /** Absent on a related item (a parent, a child): the provider is not asked for them there. */
  labels?: TrackerLabel[];
  assignee?: TrackerPerson | null;
  /** Linear: the team. */
  container?: TrackerContainer | null;
  parent?: TrackerItemSummary | null;
  progress?: TrackerProgress | null;
  /** The identifiers this item waits on (Local: the `blockedBy` frontmatter field). */
  blockedBy?: string[];
  /** At least one blocker is neither done nor canceled; the provider computes it. */
  blocked?: boolean;
  /** The provider's grouping slug; Local reads it from the `feature` frontmatter field. */
  feature?: string | null;
  updatedAt?: string | null;
};

export type TrackerComment = { id: string; body: string; createdAt: string | null; author: TrackerPerson | null };

export type TrackerItem = TrackerItemSummary & {
  description?: string | null;
  comments?: TrackerComment[];
  /** In the provider's order; the first page only, `childrenMore` says there are others. */
  children?: TrackerItemSummary[];
  childrenMore?: boolean;
};

/** Live state of a linked work item, refreshed in batches for list surfaces. */
export type TrackerLiveSummary = { identifier: string; title: string; state: { name: string; category: TrackerStateCategory } };

export type TrackerWorkflowState = { id: string; name: string; category: TrackerStateCategory | null; position: number };

export type TrackerPeopleFilter = 'any' | 'me' | 'created';
export type TrackerPriorityFilter = 'all' | TrackerPriority;

/**
 * The values a list offers as filter options, computed over the whole scope the
 * list reads rather than over the page it returns: options narrowed by the
 * filter in force would leave the chosen one as the only one pickable.
 */
export type TrackerListFacets = {
  /** Every grouping slug in scope; the values `TrackerListOptions.feature` accepts. */
  feature?: string[];
  /** Every assignee name in scope, so the board offers the spellings in use. */
  assignee?: string[];
};

export type TrackerListOptions = {
  query?: string;
  cursor?: string;
  /** One of the descriptor's `stateFilters`; omitted means `open`. */
  state?: string;
  people?: TrackerPeopleFilter;
  priority?: TrackerPriorityFilter;
  /** One grouping slug's items (Local: `feature`); every item's when absent. */
  feature?: string;
  /** One container's items (a Linear team); every container's when absent. */
  containerId?: string | null;
};

export type TrackerAccount = {
  id: string;
  name: string | null;
  user?: TrackerPerson | null;
  current: boolean;
  authorizedAt?: number | null;
  /** An extension tracker's account: whether its server still takes the credential, and how it signed in. */
  status?: 'valid' | 'invalid';
  invalidReason?: string;
  method?: 'oauth' | 'token';
};

/**
 * What an extension tracker's card needs beside the accounts: the server the
 * accounts live on (null until a `user` instance is connected), whether an
 * OAuth client is saved, and where the browser sign-in returns. A built-in
 * tracker answers none.
 */
export type TrackerConnectInfo = {
  instance: string | null;
  instances: { kind: 'fixed'; origin: string } | { kind: 'user'; label: string; placeholder?: string };
  hasClient: boolean;
  redirectUri: string | null;
};

/** Disconnected with `accounts` means every stored account is written off: the card shows them so the user can reconnect or remove them. */
export type TrackerAuthStatus =
  | { connected: false; accounts?: TrackerAccount[]; connect?: TrackerConnectInfo }
  | { connected: true; account?: TrackerAccount | null; accounts?: TrackerAccount[]; connect?: TrackerConnectInfo };

/** Why an extension tracker's connect was refused; the card names each in the user's words. */
export type TrackerConnectFailureCode =
  | 'UNSUPPORTED'
  | 'INSTANCE_REQUIRED'
  | 'INSTANCE_MISMATCH'
  | 'UNSUPPORTED_INSTANCE'
  | 'TOKEN_REQUIRED'
  | 'TOKEN_REFUSED'
  | 'USERNAME_REQUIRED'
  | 'USERNAME_INVALID'
  | 'CLIENT_MISSING'
  | 'CONNECT_SUPERSEDED'
  | 'TRACKER_UNAVAILABLE'
  | 'failed';

export type TrackerConnectResult = { ok: true } | { ok: false; code: TrackerConnectFailureCode; message: string | null };

export type TrackerAuthOrigin = 'desktop' | 'web';

/** A token the user pasted on the card; `instance` only while the tracker has no server yet, `username` for a Basic-auth scheme. */
export type TrackerConnectTokenInput = { instance?: string; token: string; username?: string };

/** The OAuth app the user registered with the tracker; `instance` only while the tracker has no server yet. */
export type TrackerOAuthClientInput = { instance?: string; clientId: string; clientSecret?: string };
export type TrackerAuthStart = { authorizationUrl: string; expiresIn: number };

type Connected<T> = { connected: false } | ({ connected: true } & T);

export type TrackerListResult = Connected<{ items: TrackerItemSummary[]; cursor: string | null; hasMore: boolean; facets?: TrackerListFacets }>;
export type TrackerItemResult = Connected<{ item: TrackerItem | null }>;
export type TrackerStatesResult = Connected<{ states: TrackerWorkflowState[] }>;
export type TrackerStateUpdateInput = { id: string; stateId: string };

/** Create input for `POST /api/tracker/:provider/items/create`; the container (a Linear team, a local project) is required. */
export type TrackerCreateItemInput = {
  containerId: string;
  title: string;
  description?: string | null;
  priority?: TrackerPriority | null;
  labels?: string[];
  /** Who it is assigned to, by name; a tracker whose `assignee` capability is off ignores it. */
  assignee?: string | null;
  /** Grouping slug; a tracker whose `feature` capability is off ignores it. */
  feature?: string | null;
  /** Identifiers of the items this one waits on. */
  blockedBy?: string[];
};

/**
 * Edit input for `POST /api/tracker/:provider/items/edit`. Only the fields the
 * input carries are forwarded; an absent field leaves the stored value alone,
 * an explicit `null` clears it.
 */
export type TrackerEditItemInput = {
  id: string;
  /**
   * The container the item lives in. Identifiers restart per container (each
   * project numbers from `LOCAL-1`), so without it a tracker that has several
   * finds the first project holding that number and edits that one.
   */
  containerId?: string;
  title?: string;
  description?: string | null;
  priority?: TrackerPriority | null;
  labels?: string[];
  /** Who it is assigned to; an explicit `null` unassigns it. */
  assignee?: string | null;
  /** An explicit `null` clears the slug. */
  feature?: string | null;
  /** Replaces the whole list; `[]` clears it. */
  blockedBy?: string[];
};

/**
 * Delete input for `DELETE /api/tracker/:provider/items`. The container is
 * named for the same reason the edit carries one: identifiers restart per
 * container.
 */
export type TrackerDeleteItemInput = { id: string; containerId?: string };

export type TrackerAuthMethod = 'oauth' | 'token';

/**
 * Plain JSON, as `GET /api/tracker/providers` answers. No icon and no
 * translated text: the UI adds those per id (`presentation.ts`).
 */
export type TrackerDescriptor = {
  id: TrackerProviderId;
  /** Product name, shown untranslated. */
  name: string;
  authMethods: TrackerAuthMethod[];
  capabilities: {
    multipleAccounts: boolean;
    stateUpdate: boolean;
    children: boolean;
    labels: boolean;
    priority: boolean;
    /** Items carry a grouping slug (`feature`), so filters and forms can offer one. */
    feature: boolean;
    /** Items wait on others by identifier (`blockedBy`), so an item can be given blockers and shown them. */
    blockers: boolean;
    /** Who an item is assigned to can be set, as the name written into `assignee`. */
    assignee: boolean;
    filters: { people: boolean; priority: boolean };
    /** Container to OpenChamber project mapping (Linear: team). */
    projectMapping: boolean;
    /** Started/completed/failure comments on the item. */
    sessionComments: boolean;
    /** An SDK guest may borrow the token. */
    hostAccess: boolean;
    /**
     * The item's `url` is a page outside the app (Linear). False when it only
     * names the item — Local's links carry a synthetic host and reach no
     * server — so the UI opens and copies them in-app instead of handing a
     * browser a dead address.
     */
    externalUrl: boolean;
    /**
     * `state.name` is a generated slug the UI translates by state id (Local's
     * `triage`, `todo`…), not words someone wrote in the tracker (Linear's
     * "In Progress", which is shown as is). Absent on an older server: false.
     */
    translatedStates?: boolean;
    /**
     * A container is an OpenChamber project folder (Local reads `.issues/`
     * inside it), so the board scopes the list by the project it shows rather
     * than by a container of the tracker's own (Linear's team). Absent: false.
     */
    containersAreProjects?: boolean;
    /** UI can create items (POST items/create); absent on an older server, read as false. */
    create?: boolean;
    /** UI can edit item fields (POST items/edit); absent on an older server, read as false. */
    edit?: boolean;
    /**
     * The item can be deleted (DELETE items), so the edit form offers the
     * action. Absent on an older server, read as false.
     */
    delete?: boolean;
    /**
     * A viewer can post a comment on the item (POST items/comment), so the
     * preview shows a composer. Absent on an older server, read as false.
     */
    itemComments?: boolean;
  };
  /** In menu order: `open`, `all`, categories, then provider extras (`inReview`, `duplicate`). */
  stateFilters: string[];
  /**
   * `host` compared to the URL host without `www.`; `path` is a regex source
   * tested on the pathname, group 1 = identifier. With `query`, the path names
   * no identifier and the parameter `query.name` carries it, checked against
   * `identifierPattern`.
   */
  urlPatterns: { host: string; path: string; query?: { name: string } }[];
  identifierPattern: string;
};

export type TrackerContainerMapping = TrackerContainer & { projectPath: string | null };
export type TrackerMappingResult = Connected<{ defaultProjectPath: string | null; containers: TrackerContainerMapping[] }>;
export type TrackerMappingWrite = { defaultProjectPath: string | null; containerProjectPaths: { [containerId: string]: string } };

export type TrackerPreferences = {
  /** Status comments are off until the user opts in. */
  sessionComments: boolean;
};

export type TrackerSessionStatusKind = 'started' | 'completed' | 'failure';

export type TrackerSessionStatusPostInput = {
  kind: TrackerSessionStatusKind;
  sessionId: string;
  identifier?: string;
  sessionOrigin?: string;
};

export type TrackerSessionStatusPostResult =
  | { connected: false }
  | { connected: true; posted: true; commentId: string | null }
  | {
    connected: true;
    posted: false;
    skipped: 'already-posted' | 'issue-not-found' | 'not-started' | 'disabled' | 'origin-not-public';
  };

/**
 * Work-item trackers the connected server serves. Every call names the
 * tracker; an action a tracker's capabilities leave out rejects.
 */
export interface TrackerAPI {
  /** The server's trackers; Linear on a server that predates the route. Rejects on failure, never answers empty for it. */
  providers(): Promise<TrackerDescriptor[]>;
  authStatus(provider: TrackerProviderId): Promise<TrackerAuthStatus>;
  /** `instance` is the server an extension tracker's `user` instance signs in to, typed on its card before the first account. */
  authStart(provider: TrackerProviderId, origin?: TrackerAuthOrigin, options?: { instance?: string }): Promise<TrackerAuthStart>;
  /** An extension tracker that takes a pasted token; the card refreshes the status on `ok`. */
  authConnectToken(provider: TrackerProviderId, input: TrackerConnectTokenInput): Promise<TrackerConnectResult>;
  /** An extension tracker that signs in through the browser: the OAuth client the user registered for it. */
  authSaveOAuthClient(provider: TrackerProviderId, input: TrackerOAuthClientInput): Promise<TrackerConnectResult>;
  authDisconnect(provider: TrackerProviderId): Promise<{ removed: boolean }>;
  authActivate(provider: TrackerProviderId, accountId: string): Promise<TrackerAuthStatus>;
  list(provider: TrackerProviderId, options?: TrackerListOptions): Promise<TrackerListResult>;
  /** Forgets the server's short-lived lists of this tracker, so the next list read asks it: the board's list refresh. */
  refreshListReads(provider: TrackerProviderId): Promise<void>;
  get(provider: TrackerProviderId, id: string, containerId?: string | null): Promise<TrackerItemResult>;
  states(provider: TrackerProviderId, containerId: string): Promise<TrackerStatesResult>;
  updateState(provider: TrackerProviderId, input: TrackerStateUpdateInput): Promise<TrackerItemResult>;
  mappingGet(provider: TrackerProviderId): Promise<TrackerMappingResult>;
  mappingSet(provider: TrackerProviderId, mapping: TrackerMappingWrite): Promise<TrackerMappingResult>;
  sessionStatusPost(provider: TrackerProviderId, input: TrackerSessionStatusPostInput): Promise<TrackerSessionStatusPostResult>;
  preferencesGet(provider: TrackerProviderId): Promise<TrackerPreferences>;
  preferencesSet(provider: TrackerProviderId, preferences: TrackerPreferences): Promise<TrackerPreferences>;
}
