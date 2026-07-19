import { createRequire } from 'module';
import { existsSync, rmSync } from 'fs';
import { basename } from 'path';
import { spawnSync } from 'child_process';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import {
  interactionCommandPath,
  patchInteractionSession,
  readInteractionCommand,
  removeInteractionCommand,
} from './interaction-session';
import type { BrowserHandoffLaunchSpec } from './browser-handoff';

const POLL_MS = 300;
const HEARTBEAT_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostnameAllowed(hostname: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  const normalized = hostname.toLowerCase();
  return allowedDomains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function assertAllowed(url: string, allowedDomains?: string[]): void {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !hostnameAllowed(parsed.hostname, allowedDomains)) {
    throw new Error(`URL is outside the browser handoff allowlist: ${url}`);
  }
}

function applicationName(channel?: string): string | undefined {
  if (channel === 'chrome') return 'Google Chrome';
  if (channel === 'chrome-beta') return 'Google Chrome Beta';
  if (channel === 'chrome-dev') return 'Google Chrome Dev';
  if (channel === 'chrome-canary') return 'Google Chrome Canary';
  if (!channel || channel === 'chromium') return 'Chromium';
  return undefined;
}

function activateRunningApplication(pid: number): boolean {
  const script = [
    'ObjC.import("AppKit")',
    `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})`,
    'if (!app) throw new Error("application not found")',
    'const options = $.NSApplicationActivateIgnoringOtherApps | $.NSApplicationActivateAllWindows',
    'if (!app.activateWithOptions(options)) throw new Error("activation rejected")',
  ].join(';');
  return spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { stdio: 'ignore' }).status === 0;
}

function presentForeground(channel?: string): boolean {
  if (process.platform !== 'darwin') return false;
  const app = applicationName(channel);
  if (app && spawnSync('/usr/bin/open', ['-a', app], { stdio: 'ignore' }).status === 0) return true;
  const children = spawnSync('/usr/bin/pgrep', ['-P', String(process.pid)], { encoding: 'utf8' });
  if (children.status !== 0) return false;
  return children.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .some(activateRunningApplication);
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('browser handoff launch spec path is required');
  const spec = readJsonFile<BrowserHandoffLaunchSpec>(specPath);
  assertAllowed(spec.url, spec.allowedDomains);
  const playwright = createRequire(import.meta.url)('playwright') as {
    chromium: {
      launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<{
        pages(): Array<{
          goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
          url(): string;
          title(): Promise<string>;
          bringToFront?(): Promise<void>;
        }>;
        newPage(): Promise<{
          goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
          url(): string;
          title(): Promise<string>;
          bringToFront?(): Promise<void>;
        }>;
        route(pattern: string, handler: (route: {
          request(): { url(): string };
          continue(): Promise<void>;
          abort(errorCode?: string): Promise<void>;
        }) => Promise<void> | void): Promise<void>;
        close(): Promise<void>;
      }>;
    };
  };
  const launchOptions: Record<string, unknown> = {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    ...(spec.executablePath ? { executablePath: spec.executablePath } : {}),
    ...(!spec.executablePath && spec.browserChannel && spec.browserChannel !== 'chromium'
      ? { channel: spec.browserChannel }
      : {}),
    ...(spec.profileDirectory ? { args: [`--profile-directory=${spec.profileDirectory}`] } : {}),
  };
  let context: Awaited<ReturnType<typeof playwright.chromium.launchPersistentContext>> | undefined;
  let terminalOutcome: {
    status: 'completed' | 'closed' | 'failed';
    error?: { code: string; message: string };
    result?: { url?: string; title?: string };
  } | undefined;
  const terminate = (status: 'closed' | 'failed', code: string, message: string): void => {
    if (terminalOutcome) return;
    terminalOutcome = { status, ...(status === 'failed' ? { error: { code, message } } : {}) };
    patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
      status: 'closing',
      error: terminalOutcome.error,
    });
  };
  const onSignal = (): void => terminate('closed', 'HANDOFF_CANCELLED', 'The browser handoff was cancelled.');
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    context = await playwright.chromium.launchPersistentContext(spec.profileDir, launchOptions);
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      try {
        const parsed = new URL(requestUrl);
        if (['http:', 'https:'].includes(parsed.protocol) && !hostnameAllowed(parsed.hostname, spec.allowedDomains)) {
          await route.abort('blockedbyclient');
          return;
        }
      } catch {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: spec.defaultTimeoutMs });
    if (page.bringToFront) await page.bringToFront();
    const foregroundPresented = presentForeground(spec.browserChannel);
    patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
      status: 'waiting_for_user',
      host: {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        foregroundPresented,
      },
      result: { url: page.url(), title: await page.title() },
    });

    let lastHeartbeat = 0;
    while (!terminalOutcome) {
      const nowMs = Date.now();
      if (nowMs >= Date.parse(spec.expiresAt)) {
        terminate('failed', 'HANDOFF_EXPIRED', 'The browser handoff expired before it was resumed.');
        break;
      }
      const pages = context.pages();
      if (pages.length === 0) {
        terminate('failed', 'BROWSER_CLOSED_BY_USER', 'The browser window was closed before the handoff was resumed.');
        break;
      }
      page = pages[pages.length - 1] ?? page;
      if (nowMs - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = nowMs;
        patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, {
          host: { pid: process.pid, heartbeatAt: new Date(nowMs).toISOString() },
          result: { url: page.url(), title: await page.title() },
        });
      }
      const cancel = readInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'cancel');
      if (cancel) {
        removeInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'cancel');
        terminate('closed', 'HANDOFF_CANCELLED', 'The browser handoff was cancelled.');
        break;
      }
      const resume = readInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'resume');
      if (resume) {
        removeInteractionCommand(spec.repoRoot, 'browser', spec.interactionId, 'resume');
        assertAllowed(page.url(), spec.allowedDomains);
        const existing = existsSync(spec.sessionPath)
          ? readJsonFile<Record<string, unknown>>(spec.sessionPath, {})
          : {};
        const timestamp = new Date().toISOString();
        const result = { url: page.url(), title: await page.title() };
        writeJsonAtomic(spec.sessionPath, {
          schemaVersion: 1,
          sessionId: spec.sessionId,
          ...result,
          createdAt: typeof existing.createdAt === 'string' ? existing.createdAt : timestamp,
          updatedAt: timestamp,
        });
        terminalOutcome = { status: 'completed', result };
        patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, { status: 'closing', result });
        break;
      }
      await delay(POLL_MS);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminate('failed', 'HANDOFF_HOST_FAILED', message);
  } finally {
    if (context) await context.close().catch(() => undefined);
    rmSync(specPath, { force: true });
    for (const kind of ['resume', 'cancel'] as const) {
      rmSync(interactionCommandPath(spec.repoRoot, 'browser', spec.interactionId, kind), { force: true });
    }
    if (!terminalOutcome) {
      terminate('failed', 'HANDOFF_HOST_EXITED', `Browser handoff host ${basename(specPath)} exited without a terminal result.`);
    }
    if (terminalOutcome) patchInteractionSession(spec.repoRoot, 'browser', spec.interactionId, terminalOutcome);
  }
}

void main().catch((error) => {
  console.error('[repo-harness browser handoff]', error);
  process.exitCode = 1;
});
