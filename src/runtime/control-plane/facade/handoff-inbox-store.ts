import { mkdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  type HandoffInboxStore,
  type HandoffItem,
  type HandoffStatus,
  isTerminalHandoffStatus,
} from './types';

export interface HandoffInboxStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface HandoffInboxStoreOptions extends HandoffInboxStoreLocation {
  now?: () => string;
}

export type CreateHandoffInput = Omit<HandoffItem, 'schemaVersion' | 'status' | 'createdAt' | 'updatedAt'> & {
  status?: HandoffStatus;
  createdAt?: string;
  updatedAt?: string;
};

export interface ListHandoffOptions extends HandoffInboxStoreOptions {
  status?: HandoffStatus | 'active' | 'all';
  limit?: number;
}

function nowIso(options: HandoffInboxStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function handoffInboxRoot(location: HandoffInboxStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome || !location.repoId) {
    throw new Error('handoff inbox requires either root or controllerHome + repoId');
  }
  const root = join(repositoryControllerRoot(location.controllerHome, location.repoId), 'handoff-inbox');
  mkdirSync(root, { recursive: true });
  return root;
}

export function handoffInboxPath(location: HandoffInboxStoreLocation): string {
  return join(handoffInboxRoot(location), 'index.json');
}

export function emptyHandoffInboxStore(updatedAt: string): HandoffInboxStore {
  return { schemaVersion: 1, updatedAt, items: [] };
}

export function readHandoffInboxStore(options: HandoffInboxStoreOptions): HandoffInboxStore {
  return readJsonFile<HandoffInboxStore>(handoffInboxPath(options), emptyHandoffInboxStore(nowIso(options)));
}

export function writeHandoffInboxStore(options: HandoffInboxStoreOptions, store: HandoffInboxStore): HandoffInboxStore {
  writeJsonAtomic(handoffInboxPath(options), store);
  return store;
}

export function createHandoffItem(options: HandoffInboxStoreOptions, input: CreateHandoffInput): HandoffItem {
  const at = input.createdAt ?? input.updatedAt ?? nowIso(options);
  const item: HandoffItem = {
    ...input,
    id: sanitizeFileComponent(input.id),
    schemaVersion: 1,
    status: input.status ?? 'pending',
    createdAt: at,
    updatedAt: input.updatedAt ?? at,
  };
  const store = readHandoffInboxStore(options);
  if (store.items.some((existing) => existing.id === item.id)) {
    throw new Error(`handoff already exists: ${item.id}`);
  }
  const nextStore: HandoffInboxStore = {
    schemaVersion: 1,
    updatedAt: item.updatedAt,
    items: [item, ...store.items],
  };
  writeHandoffInboxStore(options, nextStore);
  return item;
}

export function listHandoffItems(options: ListHandoffOptions): HandoffItem[] {
  const store = readHandoffInboxStore(options);
  const status = options.status ?? 'pending';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  return store.items
    .filter((item) => {
      if (status === 'all') return true;
      if (status === 'active') return !isTerminalHandoffStatus(item.status);
      return item.status === status;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export function getHandoffItem(options: HandoffInboxStoreOptions, id: string): HandoffItem | undefined {
  const sanitizedId = sanitizeFileComponent(id);
  return readHandoffInboxStore(options).items.find((item) => item.id === sanitizedId);
}

function setHandoffStatus(options: HandoffInboxStoreOptions, id: string, status: HandoffStatus): HandoffItem {
  const sanitizedId = sanitizeFileComponent(id);
  const store = readHandoffInboxStore(options);
  const index = store.items.findIndex((item) => item.id === sanitizedId);
  if (index < 0) throw new Error(`handoff not found: ${sanitizedId}`);
  const at = nowIso(options);
  const item: HandoffItem = { ...store.items[index], status, updatedAt: at };
  const items = [...store.items];
  items[index] = item;
  writeHandoffInboxStore(options, { schemaVersion: 1, updatedAt: at, items });
  return item;
}

export function acknowledgeHandoffItem(options: HandoffInboxStoreOptions, id: string): HandoffItem {
  return setHandoffStatus(options, id, 'acknowledged');
}

export function resolveHandoffItem(options: HandoffInboxStoreOptions, id: string): HandoffItem {
  return setHandoffStatus(options, id, 'resolved');
}
