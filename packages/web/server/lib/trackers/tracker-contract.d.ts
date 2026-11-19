import type { RegisteredTrackerImplementation } from './registry.js';
export type TrackerProviderId = string;
export type TrackerStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type TrackerPerson = { name: string | null; avatarUrl: string | null };

export type TrackerItemSummary = {
  provider: TrackerProviderId;
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { id: string | null; name: string; category: TrackerStateCategory | null } | null;
  priority?: TrackerPriority | null;
  labels?: { id: string; name: string; color: string | null }[];
  assignee?: TrackerPerson | null;
  container?: { id: string; key: string | null; name: string } | null;
  parent?: TrackerItemSummary | null;
  progress?: { total: number; done: number; more: boolean } | null;
  /** The identifiers this item waits on (Local: the `blockedBy` frontmatter field). */
  blockedBy?: string[];
  /**
   * At least one identifier in `blockedBy` names an item that is neither done
   * nor canceled. The provider computes it: only it knows its blockers' states.
   */
  blocked?: boolean;
  /** The provider's grouping slug; Local reads it from the `feature` frontmatter field. */
  feature?: string | null;
  updatedAt?: string | null;
};

export type TrackerComment = { id: string; body: string; createdAt: string | null; author: TrackerPerson | null };

export type TrackerItem = TrackerItemSummary & {
  description?: string | null;
  comments?: TrackerComment[];
  children?: TrackerItemSummary[];
  childrenMore?: boolean;
};

export type TrackerLiveSummary = { identifier: string; title: string; state: { name: string; category: TrackerStateCategory } };

export type TrackerLiveSummaryWire = TrackerLiveSummary & { state: TrackerLiveSummary['state'] & { type?: string } };

export type TrackerWorkflowState = { id: string; name: string; category: TrackerStateCategory | null; position: number };

export type TrackerPeopleFilter = 'any' | 'me' | 'created';
export type TrackerPriorityFilter = 'all' | TrackerPriority;

/**
 * The values a list offers as filter options, computed over the whole scope the
 * list reads (the container) rather than over the page it returns: a filter
 * whose options came from its own result would leave the chosen one as the only
 * option. Absent for a tracker with no facets.
 */
export type TrackerListFacets = {
  /** Every grouping slug in scope; the values `TrackerListOptions.feature` accepts. */
  feature?: string[];
};

export type TrackerListOptions = {
  query?: string | undefined;
  cursor?: string | undefined;
  state?: string;
  people?: TrackerPeopleFilter;
  priority?: TrackerPriorityFilter;
  /** One grouping slug's items (Local: `feature`); every item's when absent. */
  feature?: string;
  containerId?: string | null;
};

export type TrackerAccount = {
  id: string;
  name: string | null;
  user?: TrackerPerson | null;
  current: boolean;
  authorizedAt?: number | null;
  status?: 'valid' | 'invalid';
  invalidReason?: string;
  method?: 'oauth' | 'token';
};

export type TrackerConnectInfo = {
  instance: string | null;
  instances: { kind: 'fixed'; origin: string } | { kind: 'user'; label: string; placeholder?: string };
  hasClient: boolean;
  redirectUri: string | null;
};

export type TrackerAuthStatus =
  | { connected: false; accounts?: TrackerAccount[]; connect?: TrackerConnectInfo }
  | { connected: true; account?: TrackerAccount | null; accounts?: TrackerAccount[]; connect?: TrackerConnectInfo };

export type Connected<T> = { connected: false } | ({ connected: true } & T);

export type TrackerAuthMethod = 'oauth' | 'token';

export type TrackerDescriptor = {
  id: TrackerProviderId;
  name: string;
  authMethods: readonly TrackerAuthMethod[];
  capabilities: {
    multipleAccounts: boolean;
    stateUpdate: boolean;
    children: boolean;
    labels: boolean;
    priority: boolean;
    /** Items carry a grouping slug (`feature`), so filters and forms can offer one. */
    feature: boolean;
    /** Items wait on others by identifier (`blockedBy`), so a form can offer the field. */
    blockers: boolean;
    /**
     * The board can set who an item is assigned to, as the name it writes into
     * `assignee`. False when assignment needs the tracker's own member list
     * (Linear picks a person by id), leaving the row read-only.
     */
    assignee: boolean;
    filters: { people: boolean; priority: boolean };
    projectMapping: boolean;
    sessionComments: boolean;
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
     * "In Progress", which is shown as is). False when names are content.
     */
    translatedStates: boolean;
    /**
     * A container is an OpenChamber project folder (Local reads `.issues/`
     * inside it), so the board scopes the list by the project it is showing
     * rather than by a container of the tracker's own (Linear's team). False
     * when the tracker names containers the board has to offer separately.
     */
    containersAreProjects: boolean;
    /** UI can create items (POST items/create). */
    create: boolean;
    /** UI can edit item fields (POST items/edit). */
    edit: boolean;
    /**
     * The item can be deleted for good (DELETE items), so the edit form offers
     * the action. False when the tracker has no way to delete one.
     */
    delete: boolean;
    /** UI can post a comment on an item (POST items/comment). */
    itemComments: boolean;
  };
  stateFilters: readonly string[];
  urlPatterns: readonly { host: string; path: string; query?: { name: string } }[];
  identifierPattern: string;
};

export type TrackerMappingView = {
  defaultProjectPath: string | null;
  containers: { id: string; key: string | null; name: string; projectPath: string | null }[];
};
export type TrackerMappingRequest = { defaultProjectPath: unknown; containerProjectPaths: object };
export type TrackerPreferences = { sessionComments: boolean };
export type TrackerSessionStatusKind = 'started' | 'completed' | 'failure';
export type TrackerSessionStatusInput = { kind: TrackerSessionStatusKind; sessionId: string; identifier?: string; sessionOrigin?: string };
export type TrackerSessionStatusResult = Connected<{ posted?: boolean; skipped?: string; commentId?: string }>;

export type TrackerRuntimeEvent = {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { sessionID?: string; type?: string };
    status?: { type?: string };
    error?: { name?: string };
  };
};

export interface TrackerSessionStatusRuntime {
  processPayload(payload: TrackerRuntimeEvent): void;
  stop(): void;
}

export type TrackerCreateItemInput = {
  containerId: string;
  title: string;
  description?: string | null;
  priority?: TrackerPriority | null;
  labels?: string[];
  /** Grouping slug; a tracker whose `feature` capability is off ignores it. */
  feature?: string | null;
  /** Identifiers of the items this one waits on. */
  blockedBy?: string[];
};
export type TrackerEditItemInput = {
  id: string;
  title?: string;
  description?: string | null;
  priority?: TrackerPriority | null;
  labels?: string[];
  /** An explicit `null` clears the slug. */
  feature?: string | null;
  /** Replaces the whole list; `[]` clears it. */
  blockedBy?: string[];
};

/** The item to delete, and the container it is in when identifiers repeat. */
export type TrackerDeleteItemInput = { id: string; containerId?: string };

/** A comment to append to an item, and the container it is in when identifiers repeat. */
export type TrackerCommentInput = { id: string; body: string; containerId?: string };

/** The public view of an extension tracker's accounts (`extension-accounts.js`). */
export type TrackerAccountsView = {
  instance: string | null;
  accounts: Array<{ id: string; login: string | null; name?: string; avatarUrl?: string; connectedAt: number; status: 'valid' | 'invalid'; invalidReason?: string; method: 'oauth' | 'token' }>;
  activeAccountId: string | null;
  hasClient: boolean;
};

export interface TrackerImplementation {
  auth: {
    status(input?: { origin?: string | null }): Promise<TrackerAuthStatus>;
    start(input?: { origin?: 'desktop' | 'web'; callbackOrigin?: string | null; instance?: string | undefined }): Promise<{ authorizationUrl: string; expiresIn: number }>;
    disconnect(): Promise<{ removed: boolean }>;
    activate(accountId: string): Promise<TrackerAuthStatus | null>;
    connectToken?(input: { instance?: string | undefined; token: unknown; username?: string | undefined }): Promise<TrackerAccountsView>;
    setOAuthClient?(input: { instance?: string | undefined; clientId: unknown; clientSecret?: unknown }): Promise<TrackerAccountsView>;
    completeAuthorization?(input: { code: string; state: string; error: string; errorDescription: string }): Promise<TrackerAccountsView>;
  };
  list(options: TrackerListOptions): Promise<Connected<{ items: TrackerItemSummary[]; cursor: string | null; hasMore: boolean; facets?: TrackerListFacets }>>;
  get(id: string): Promise<Connected<{ item: TrackerItem | null }>>;
  states(containerId: string): Promise<Connected<{ states: TrackerWorkflowState[] }>>;
  updateState(input: { id: string; stateId: string }): Promise<Connected<{ item: TrackerItem | null }>>;
  create(input: TrackerCreateItemInput): Promise<Connected<{ item: TrackerItem | null }>>;
  edit(input: TrackerEditItemInput): Promise<Connected<{ item: TrackerItem | null }>>;
  /**
   * Removes the item for good. Optional: a tracker without a delete has no
   * `remove`, and its `delete` capability is false, so the route answers
   * UNSUPPORTED before reaching here.
   */
  remove?(input: TrackerDeleteItemInput): Promise<Connected<{ removed: boolean }>>;
  /**
   * Appends a comment to the item as the viewer wrote it. Optional: a tracker
   * without user comments has no `comment`, and its `itemComments` capability
   * is false, so the route answers UNSUPPORTED before reaching here.
   */
  comment?(input: TrackerCommentInput): Promise<Connected<{ item: TrackerItem | null }>>;
  liveSummaries(identifiers: string[]): Promise<Connected<{ items: TrackerLiveSummaryWire[] }>>;
  matchUrl(url: string): string | null;
  mapping?: {
    get(): Promise<Connected<TrackerMappingView>>;
    set(input: TrackerMappingRequest): Promise<Connected<TrackerMappingView>>;
  };
  preferences?: {
    get(): Promise<TrackerPreferences>;
    set(input: TrackerPreferences): Promise<TrackerPreferences>;
  };
  sessionStatus?: {
    post(input: TrackerSessionStatusInput): Promise<TrackerSessionStatusResult>;
    createRuntime(): TrackerSessionStatusRuntime;
  };
  hostAccess?: {
    apiOrigin: string;
    account(): Promise<{ connected: boolean; label: string }>;
    accessToken(): Promise<string | null>;
    start(): Promise<{ authorizationUrl: string; expiresIn: number }>;
    disconnect(): Promise<void>;
  };
}

export type TrackerEntry = {
  descriptor: TrackerDescriptor;
  load(): Promise<TrackerImplementation>;
};

export interface TrackerRegistry {
  has(id: string): boolean;
  descriptor(id: string): TrackerDescriptor | null;
  descriptors(): readonly TrackerDescriptor[];
  list(): readonly TrackerProviderId[];
  implementation(id: string): Promise<RegisteredTrackerImplementation | null>;
}
