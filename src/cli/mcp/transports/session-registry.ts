export type McpSessionRoute = '/mcp' | '/mcp-grok' | '/mcp-bearer';

export type McpSessionCloseReason =
  | 'client_delete'
  | 'transport_close'
  | 'superseded'
  | 'principal_capacity'
  | 'capacity_eviction'
  | 'idle_ttl'
  | 'stream_lease'
  | 'absolute_lifetime'
  | 'shutdown';

export interface ClosableMcpTransport {
  close(): Promise<void> | void;
}

export interface ManagedMcpSession<
  TTransport extends ClosableMcpTransport = ClosableMcpTransport,
  TContext = unknown,
> {
  sessionId: string;
  transport: TTransport;
  toolContext: TContext;
  route: McpSessionRoute;
  principalId: string;
  clientIdentity: string;
  createdAt: number;
  lastActivityAt: number;
  streamOpenedAt?: number;
  postOpenedAt?: number;
  inFlightPosts: number;
  inFlightGets: number;
  pendingCloseReason?: McpSessionCloseReason;
}

export interface McpSessionCloseCounters {
  clientDelete: number;
  transportClose: number;
  superseded: number;
  principalCapacity: number;
  capacityEviction: number;
  idleTtl: number;
  streamLease: number;
  absoluteLifetime: number;
  shutdown: number;
}

export interface McpSessionSnapshot {
  active: number;
  maximum: number;
  capacityAvailable: number;
  utilization: number;
  acceptingNewSessions: boolean;
  evictable: number;
  protected: number;
  activePosts: number;
  activeStreams: number;
  oldestStreamAgeMs: number;
  oldestPostAgeMs: number;
  recoveryRecommended: boolean;
  closed: McpSessionCloseCounters;
}

export interface McpSessionRegistryOptions {
  maximumSessions?: number;
  maximumSessionsPerPrincipal?: number;
  idleTtlMs?: number;
  streamLeaseMs?: number;
  absoluteLifetimeMs?: number;
  activePostStallMs?: number;
  now?: () => number;
}

interface RegisterMcpSession<TTransport extends ClosableMcpTransport, TContext> {
  sessionId: string;
  transport: TTransport;
  toolContext: TContext;
  route: McpSessionRoute;
  principalId: string;
  clientIdentity: string;
  initialPost?: boolean;
}

interface InitializeCapacityRequest {
  principalId: string;
  route: McpSessionRoute;
  maximumSessionsForPrincipal?: number;
  enforcePrincipalCapacity?: boolean;
  supersedeSessionId?: string;
}

interface InitializeReservation {
  principalId: string;
  route: McpSessionRoute;
  createdAt: number;
}

const DEFAULT_MAXIMUM_SESSIONS = 64;
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;
const DEFAULT_STREAM_LEASE_MS = 30 * 60_000;
const DEFAULT_ABSOLUTE_LIFETIME_MS = 2 * 60 * 60_000;
const DEFAULT_ACTIVE_POST_STALL_MS = 10 * 60_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function emptyCloseCounters(): McpSessionCloseCounters {
  return {
    clientDelete: 0,
    transportClose: 0,
    superseded: 0,
    principalCapacity: 0,
    capacityEviction: 0,
    idleTtl: 0,
    streamLease: 0,
    absoluteLifetime: 0,
    shutdown: 0,
  };
}

function counterForReason(reason: McpSessionCloseReason): keyof McpSessionCloseCounters {
  switch (reason) {
    case 'client_delete': return 'clientDelete';
    case 'transport_close': return 'transportClose';
    case 'superseded': return 'superseded';
    case 'principal_capacity': return 'principalCapacity';
    case 'capacity_eviction': return 'capacityEviction';
    case 'idle_ttl': return 'idleTtl';
    case 'stream_lease': return 'streamLease';
    case 'absolute_lifetime': return 'absoluteLifetime';
    case 'shutdown': return 'shutdown';
  }
}

export class McpSessionRegistry<
  TTransport extends ClosableMcpTransport = ClosableMcpTransport,
  TContext = unknown,
> {
  private readonly sessions = new Map<string, ManagedMcpSession<TTransport, TContext>>();
  private readonly maximumSessions: number;
  private readonly maximumSessionsPerPrincipal: number;
  private readonly idleTtlMs: number;
  private readonly streamLeaseMs: number;
  private readonly absoluteLifetimeMs: number;
  private readonly activePostStallMs: number;
  private readonly now: () => number;
  private readonly closeCounters = emptyCloseCounters();
  private readonly initializeReservations = new Map<string, InitializeReservation>();
  private admissionQueue: Promise<void> = Promise.resolve();
  private nextReservationId = 0;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.maximumSessions = positiveInteger(options.maximumSessions, DEFAULT_MAXIMUM_SESSIONS);
    this.maximumSessionsPerPrincipal = Math.min(
      this.maximumSessions,
      positiveInteger(options.maximumSessionsPerPrincipal, this.maximumSessions),
    );
    this.idleTtlMs = positiveInteger(options.idleTtlMs, DEFAULT_IDLE_TTL_MS);
    this.streamLeaseMs = positiveInteger(options.streamLeaseMs, DEFAULT_STREAM_LEASE_MS);
    this.absoluteLifetimeMs = positiveInteger(options.absoluteLifetimeMs, DEFAULT_ABSOLUTE_LIFETIME_MS);
    this.activePostStallMs = positiveInteger(options.activePostStallMs, DEFAULT_ACTIVE_POST_STALL_MS);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): ManagedMcpSession<TTransport, TContext> | undefined {
    return this.sessions.get(sessionId);
  }

  values(): IterableIterator<ManagedMcpSession<TTransport, TContext>> {
    return this.sessions.values();
  }

  register(input: RegisterMcpSession<TTransport, TContext>): ManagedMcpSession<TTransport, TContext> {
    const now = this.now();
    const session: ManagedMcpSession<TTransport, TContext> = {
      ...input,
      createdAt: now,
      lastActivityAt: now,
      ...(input.initialPost ? { postOpenedAt: now } : {}),
      inFlightPosts: input.initialPost ? 1 : 0,
      inFlightGets: 0,
    };
    this.sessions.set(input.sessionId, session);
    return session;
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActivityAt = this.now();
  }

  beginPost(sessionId: string): ManagedMcpSession<TTransport, TContext> | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const now = this.now();
    if (session.inFlightPosts === 0) session.postOpenedAt = now;
    session.inFlightPosts += 1;
    session.lastActivityAt = now;
    return session;
  }

  endPost(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.inFlightPosts = Math.max(0, session.inFlightPosts - 1);
    if (session.inFlightPosts === 0) session.postOpenedAt = undefined;
    session.lastActivityAt = this.now();
  }

  beginStream(sessionId: string): ManagedMcpSession<TTransport, TContext> | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const now = this.now();
    if (session.inFlightGets === 0) session.streamOpenedAt = now;
    session.inFlightGets += 1;
    session.lastActivityAt = now;
    return session;
  }

  endStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.inFlightGets = Math.max(0, session.inFlightGets - 1);
    if (session.inFlightGets === 0) session.streamOpenedAt = undefined;
    session.lastActivityAt = this.now();
  }

  setPendingCloseReason(sessionId: string, reason: McpSessionCloseReason): void {
    const session = this.sessions.get(sessionId);
    if (session) session.pendingCloseReason = reason;
  }

  detach(sessionId: string, reason: McpSessionCloseReason = 'transport_close'): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.incrementCloseCounter(session.pendingCloseReason ?? reason);
    return true;
  }

  async close(sessionId: string, reason: McpSessionCloseReason): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.pendingCloseReason = reason;
    this.incrementCloseCounter(reason);
    try {
      await session.transport.close();
    } catch {
      // The peer may have already closed the stream. Registry ownership is
      // released before awaiting transport cleanup so reconnect can proceed.
    }
    return true;
  }

  async reserveForInitialize(request: InitializeCapacityRequest): Promise<string | undefined> {
    return await this.withAdmissionLock(async () => {
      await this.prune();

      if (request.supersedeSessionId) {
        const previous = this.sessions.get(request.supersedeSessionId);
        if (previous
          && previous.principalId === request.principalId
          && previous.route === request.route
          && previous.inFlightPosts === 0) {
          await this.close(previous.sessionId, 'superseded');
        }
      }

      const principalLimit = Math.min(
        this.maximumSessions,
        positiveInteger(request.maximumSessionsForPrincipal, this.maximumSessionsPerPrincipal),
      );
      if (request.enforcePrincipalCapacity !== false) {
        while (this.principalSessionCount(request.principalId) + this.principalReservationCount(request.principalId) + 1 > principalLimit) {
          const candidate = this.safeCandidates((session) => session.principalId === request.principalId)[0];
          if (!candidate) return undefined;
          await this.close(candidate.sessionId, 'principal_capacity');
        }
      }

      while (this.sessions.size + this.initializeReservations.size + 1 > this.maximumSessions) {
        const candidate = this.safeCandidates()[0];
        if (!candidate) return undefined;
        await this.close(candidate.sessionId, 'capacity_eviction');
      }

      const reservationId = `initialize-${++this.nextReservationId}`;
      this.initializeReservations.set(reservationId, {
        principalId: request.principalId,
        route: request.route,
        createdAt: this.now(),
      });
      return reservationId;
    });
  }

  commitInitialize(
    reservationId: string,
    input: RegisterMcpSession<TTransport, TContext>,
  ): ManagedMcpSession<TTransport, TContext> {
    const reservation = this.initializeReservations.get(reservationId);
    if (!reservation
      || reservation.principalId !== input.principalId
      || reservation.route !== input.route) {
      throw new Error('MCP_INITIALIZE_RESERVATION_INVALID');
    }
    this.initializeReservations.delete(reservationId);
    return this.register({ ...input, initialPost: true });
  }

  releaseInitialize(reservationId: string): void {
    this.initializeReservations.delete(reservationId);
  }

  async prune(): Promise<void> {
    const now = this.now();
    const expired = [...this.sessions.values()]
      .filter((session) => session.inFlightPosts === 0)
      .map((session): { session: ManagedMcpSession<TTransport, TContext>; reason?: McpSessionCloseReason } => {
        if (now - session.createdAt >= this.absoluteLifetimeMs) return { session, reason: 'absolute_lifetime' };
        if (session.inFlightGets > 0 && session.streamOpenedAt !== undefined && now - session.streamOpenedAt >= this.streamLeaseMs) {
          return { session, reason: 'stream_lease' };
        }
        if (session.inFlightGets === 0 && now - session.lastActivityAt >= this.idleTtlMs) return { session, reason: 'idle_ttl' };
        return { session };
      })
      .filter((entry): entry is { session: ManagedMcpSession<TTransport, TContext>; reason: McpSessionCloseReason } => Boolean(entry.reason));

    for (const { session, reason } of expired) await this.close(session.sessionId, reason);
  }

  async closeAll(reason: McpSessionCloseReason = 'shutdown'): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) await this.close(sessionId, reason);
  }

  snapshot(): McpSessionSnapshot {
    const sessions = [...this.sessions.values()];
    const reservations = [...this.initializeReservations.values()];
    const activePosts = sessions.reduce((count, session) => count + session.inFlightPosts, 0) + reservations.length;
    const activeStreams = sessions.reduce((count, session) => count + session.inFlightGets, 0);
    const evictable = sessions.filter((session) => session.inFlightPosts === 0).length;
    const reserved = reservations.length;
    const protectedCount = sessions.length - evictable + reserved;
    const capacityAvailable = Math.max(0, this.maximumSessions - sessions.length - reserved);
    const streamOpenedAt = sessions
      .filter((session) => session.inFlightGets > 0 && session.streamOpenedAt !== undefined)
      .map((session) => session.streamOpenedAt!);
    const oldestStreamAgeMs = streamOpenedAt.length === 0 ? 0 : Math.max(0, this.now() - Math.min(...streamOpenedAt));
    const postOpenedAt = sessions
      .filter((session) => session.inFlightPosts > 0 && session.postOpenedAt !== undefined)
      .map((session) => session.postOpenedAt!)
      .concat(reservations.map((reservation) => reservation.createdAt));
    const oldestPostAgeMs = postOpenedAt.length === 0 ? 0 : Math.max(0, this.now() - Math.min(...postOpenedAt));
    const acceptingNewSessions = capacityAvailable > 0 || evictable > 0;
    return {
      active: sessions.length,
      maximum: this.maximumSessions,
      capacityAvailable,
      utilization: this.maximumSessions === 0 ? 1 : (sessions.length + reserved) / this.maximumSessions,
      acceptingNewSessions,
      evictable,
      protected: protectedCount,
      activePosts,
      activeStreams,
      oldestStreamAgeMs,
      oldestPostAgeMs,
      recoveryRecommended: !acceptingNewSessions && oldestPostAgeMs >= this.activePostStallMs,
      closed: { ...this.closeCounters },
    };
  }

  private principalSessionCount(principalId: string): number {
    return [...this.sessions.values()].filter((session) => session.principalId === principalId).length;
  }

  private principalReservationCount(principalId: string): number {
    return [...this.initializeReservations.values()].filter((reservation) => reservation.principalId === principalId).length;
  }

  private async withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionQueue;
    let release!: () => void;
    this.admissionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private safeCandidates(
    predicate: (session: ManagedMcpSession<TTransport, TContext>) => boolean = () => true,
  ): ManagedMcpSession<TTransport, TContext>[] {
    return [...this.sessions.values()]
      .filter((session) => session.inFlightPosts === 0 && predicate(session))
      .sort((left, right) => {
        const leftAge = left.streamOpenedAt ?? left.lastActivityAt;
        const rightAge = right.streamOpenedAt ?? right.lastActivityAt;
        return leftAge - rightAge || left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId);
      });
  }

  private incrementCloseCounter(reason: McpSessionCloseReason): void {
    const key = counterForReason(reason);
    this.closeCounters[key] += 1;
  }
}
