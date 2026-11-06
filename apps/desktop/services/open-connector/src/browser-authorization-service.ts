import type { CatalogStore } from "./catalog-store.ts";
import type { ConnectionService, ConnectionSummary, DisconnectedConnectionSummary } from "./connection-service.ts";
import type { IProviderLoader } from "./providers/provider-loader.ts";

import { normalizeConnectionName } from "./connection-service.ts";
import { providerFetch } from "./providers/provider-runtime.ts";

export type BrowserExchangeResult =
  | { status: "pending"; message?: string }
  | { status: "authorized"; values: Record<string, string> }
  | { status: "cancelled" | "failed"; message: string };

export interface BrowserAuthorizationRuntime {
  authorizationUrl(code: string): string;
  exchange(code: string, clientId: string, fetcher: typeof fetch, signal: AbortSignal): Promise<BrowserExchangeResult>;
}

export interface BrowserAuthorizationStatus {
  sessionId: string;
  service: string;
  status: "pending" | "verifying" | "connected" | "cancelled" | "expired" | "failed";
  expiresAt: string;
  message?: string;
}

export interface BrowserAuthorizationStart extends BrowserAuthorizationStatus {
  authorizationUrl: string;
}

interface AuthorizationSession {
  public: BrowserAuthorizationStatus;
  connectionName: string;
  controller: AbortController;
  committing: boolean;
  task: Promise<void>;
}

export interface BrowserAuthorizationOptions {
  catalog: CatalogStore;
  connections: ConnectionService;
  providerLoader: IProviderLoader;
  fetcher?: typeof fetch;
}

export class BrowserAuthorizationConfigurationError extends Error {}

/** Local, authenticated browser-poll sessions. Provider credentials stay inside OpenConnector. */
export class BrowserAuthorizationService {
  private readonly sessions = new Map<string, AuthorizationSession>();
  private readonly options: BrowserAuthorizationOptions;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserAuthorizationOptions) {
    this.options = options;
  }

  start(service: string, connectionName?: string): Promise<BrowserAuthorizationStart> {
    return this.enqueue(() => this.startSession(service, normalizeConnectionName(connectionName)));
  }

  get(sessionId: string, service: string): BrowserAuthorizationStatus | undefined {
    const session = this.sessions.get(sessionId);
    return session?.public.service === service ? { ...session.public } : undefined;
  }

  async cancel(sessionId: string, service: string): Promise<BrowserAuthorizationStatus | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session || session.public.service !== service) return undefined;
    if (!session.committing && ["pending", "verifying"].includes(session.public.status)) {
      session.public.status = "cancelled";
      session.controller.abort();
    }
    await session.task;
    return { ...session.public };
  }

  disconnect(service: string, connectionName?: string): Promise<ConnectionSummary | DisconnectedConnectionSummary> {
    return this.enqueue(async () => {
      await this.cancelExisting(service);
      return this.options.connections.disconnect(service, connectionName);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.catch(() => undefined).then(operation);
    this.operations = task;
    return task;
  }

  private async cancelExisting(service: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.public.service === service) await this.cancel(session.public.sessionId, service);
    }
  }

  private async startSession(service: string, connectionName: string): Promise<BrowserAuthorizationStart> {
    const provider = this.options.catalog.providers.find((item) => item.service === service);
    if (!provider?.auth.some((auth) => auth.type === "custom_credential" && auth.interaction === "browser_poll")) {
      throw new BrowserAuthorizationConfigurationError("This provider does not support browser polling authorization.");
    }
    this.options.connections.assertProviderAvailable(service);
    const runtime = await this.options.providerLoader.loadBrowserAuthorizationRuntime?.(service);
    if (!runtime) throw new BrowserAuthorizationConfigurationError("Browser authorization is unavailable for this provider.");
    const code = crypto.randomUUID().toLowerCase();
    const authorizationUrl = runtime.authorizationUrl(code);
    await this.cancelExisting(service);
    const clientId = await this.options.connections.getInstallationId();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const session: AuthorizationSession = {
      public: { sessionId, service, status: "pending", expiresAt },
      connectionName,
      controller: new AbortController(),
      committing: false,
      task: Promise.resolve(),
    };
    for (const [id, old] of this.sessions) {
      if (Date.parse(old.public.expiresAt) < Date.now() - 300_000) this.sessions.delete(id);
    }
    this.sessions.set(sessionId, session);
    session.task = this.run(session, runtime, code, clientId);
    return { ...session.public, authorizationUrl };
  }

  private async run(
    session: AuthorizationSession,
    runtime: BrowserAuthorizationRuntime,
    code: string,
    clientId: string,
  ): Promise<void> {
    const deadline = setTimeout(() => {
      if (!session.committing) {
        session.public.status = "expired";
        session.controller.abort();
      }
    }, Math.max(0, Date.parse(session.public.expiresAt) - Date.now()));
    const signal = session.controller.signal;
    try {
      while (!signal.aborted) {
        const result = await runtime.exchange(code, clientId, this.options.fetcher ?? providerFetch, signal);
        if (signal.aborted) return;
        if (result.status === "authorized") {
          session.public.status = "verifying";
          session.public.message = "授权已完成，正在验证连接。";
          await this.options.connections.connectWithCustomCredential(session.public.service, {
            connectionName: session.connectionName,
            values: result.values,
            signal,
            beforeCommit: () => {
              signal.throwIfAborted();
              session.committing = true;
            },
          });
          session.public.status = "connected";
          delete session.public.message;
          return;
        }
        if (result.status !== "pending") {
          session.public.status = result.status;
          session.public.message = result.message;
          return;
        }
        if (result.message) session.public.message = result.message;
        else delete session.public.message;
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, 1000);
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    } catch {
      if (!signal.aborted) {
        session.public.status = "failed";
        session.public.message = "授权或连接验证失败，请重新授权后重试。";
      }
    } finally {
      clearTimeout(deadline);
    }
  }
}
