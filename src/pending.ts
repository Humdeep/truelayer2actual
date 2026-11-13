import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { createRequire } from 'module';
import type { Express, Request, Response, NextFunction } from 'express';
import { isSandbox } from './auth/oauth.js';
import type { TrueLayerTransaction } from './clients/truelayer.js';
import type { ExistingImport, ImportedIdMigration } from './mapper.js';
import type { Account } from './config.js';
import { atomicWriteFile } from './util/fs.js';
import { withStateLock } from './util/lock.js';
import { describeError } from './util/errors.js';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);

export const PENDING_MODES = ['off', 'deterministic', 'heuristic'] as const;
export type PendingMode = (typeof PENDING_MODES)[number];

export const PENDING_PREFIX = 'pending:';

const MAX_SETTLEMENT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export function isPendingMode(value: unknown): value is PendingMode {
  return typeof value === 'string' && (PENDING_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Persistent per-account pending mode storage (data/pending.json)
// ---------------------------------------------------------------------------

let pendingPath: string | null = null;

export function setPendingPathForTests(p: string): void {
  pendingPath = p;
}

function pendingPathResolve(): string {
  return (pendingPath ??= path.join(process.cwd(), 'data', 'pending.json'));
}

export function loadPendingModes(): Record<string, PendingMode> {
  const filePath = pendingPathResolve();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { modes?: Record<string, unknown> };
    const out: Record<string, PendingMode> = {};
    if (parsed && typeof parsed.modes === 'object' && parsed.modes !== null) {
      for (const [k, v] of Object.entries(parsed.modes)) {
        if (isPendingMode(v) && v !== 'off') out[k] = v;
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    logger.warn('Could not read pending.json (defaulting all accounts to off):', describeError(err));
    return {};
  }
}

export async function updatePendingModes(
  updates: Map<string, PendingMode> | Record<string, PendingMode>
): Promise<Record<string, PendingMode>> {
  const entries = updates instanceof Map ? [...updates.entries()] : Object.entries(updates);
  if (entries.length === 0) return loadPendingModes();

  return withStateLock(async () => {
    const modes = loadPendingModes();
    for (const [tlId, mode] of entries) {
      if (!tlId || !isPendingMode(mode)) continue;
      if (mode === 'off') delete modes[tlId];
      else modes[tlId] = mode;
    }
    const filePath = pendingPathResolve();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFile(filePath, JSON.stringify({ modes }, null, 2));
    return modes;
  });
}

export function pendingModeOf(
  accountOrId: { truelayerAccountId?: string; pendingSync?: PendingMode } | string,
  modes?: Record<string, PendingMode>
): PendingMode {
  if (typeof accountOrId === 'string') {
    if (!accountOrId) return 'off';
    const map = modes ?? loadPendingModes();
    return map[accountOrId] ?? 'off';
  }
  if (accountOrId.pendingSync && isPendingMode(accountOrId.pendingSync)) return accountOrId.pendingSync;
  if (!accountOrId.truelayerAccountId) return 'off';
  const map = modes ?? loadPendingModes();
  return map[accountOrId.truelayerAccountId] ?? 'off';
}

// ---------------------------------------------------------------------------
// TrueLayer pending endpoints
// ---------------------------------------------------------------------------

function truelayerBaseUrl(): string {
  return isSandbox() ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';
}

export async function fetchPendingTransactions(
  accessToken: string,
  accountId: string,
  from: string,
  to: string,
  isCard = false
): Promise<TrueLayerTransaction[]> {
  const kindPath = isCard ? 'cards' : 'accounts';
  const url = `${truelayerBaseUrl()}/data/v1/${kindPath}/${accountId}/transactions/pending`;
  logger.debug(`Fetching pending ${kindPath} transactions for ${accountId} from ${from} to ${to}`);

  try {
    const res = await axios.get<{ results: TrueLayerTransaction[] }>(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { from, to },
    });
    const list = res.data?.results ?? [];
    logger.debug(`Fetched ${list.length} pending transaction(s) for ${accountId}`);
    return list.map((t) => ({ ...t, status: 'pending' as const }));
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 501)) {
      logger.debug(`Pending ${kindPath} endpoint not supported by this provider — skipping`);
      return [];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pure reconciliation + filtering
// ---------------------------------------------------------------------------

function importedIdForTxn(t: TrueLayerTransaction): string {
  const stable = t.normalised_provider_transaction_id?.trim();
  return stable ? stable : t.transaction_id;
}

export function pendingImportedIdFor(t: TrueLayerTransaction): string {
  return `${PENDING_PREFIX}${importedIdForTxn(t)}`;
}

/**
 * Drop any pending transaction whose ID already appears in the booked list
 * (some providers briefly return a settling transaction in both endpoints).
 */
export function filterPendingTransactions(
  bookedTxns: TrueLayerTransaction[],
  pendingTxns: TrueLayerTransaction[]
): TrueLayerTransaction[] {
  if (pendingTxns.length === 0) return [];
  const bookedIds = new Set<string>();
  for (const t of bookedTxns) {
    bookedIds.add(importedIdForTxn(t));
    bookedIds.add(t.transaction_id);
  }
  return pendingTxns.filter(
    (p) => !bookedIds.has(importedIdForTxn(p)) && !bookedIds.has(p.transaction_id)
  );
}

/**
 * Stamp active pending transactions so `mapTransaction()` in `src/mapper.ts`
 * assigns `imported_id: "pending:<id>"` and `cleared: false` without needing
 * any modification to `src/mapper.ts`.
 */
export function stampPendingTransactions(pendingTxns: TrueLayerTransaction[]): TrueLayerTransaction[] {
  return pendingTxns.map((t) => {
    const prefixed = pendingImportedIdFor(t);
    return {
      ...t,
      status: 'pending',
      transaction_id: prefixed,
      normalised_provider_transaction_id: prefixed,
    };
  });
}

export interface PendingReconciliationOptions {
  bookedTxns: TrueLayerTransaction[];
  pendingTxns: TrueLayerTransaction[];
  existing: ExistingImport[];
  mode: PendingMode;
  isCard?: boolean;
  /** Whether vanished pending rows may be deleted (false if pending fetch failed). */
  canPrune?: boolean;
}

export interface PendingReconciliationPlan {
  promotions: ImportedIdMigration[];
  deletions: string[];
}

function daysBetween(fromDate: string, toDate: string): number {
  const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
  const toMs = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return NaN;
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

/**
 * Reconcile existing `pending:*` rows in Actual against the latest booked and
 * pending transactions from TrueLayer:
 *
 * 1. Active pending rows (still returned by `/transactions/pending`) are kept.
 * 2. Vanished `pending:*` rows whose underlying ID matches a newly booked
 *    transaction are promoted in-place (`pending:<id>` → `<booked_id>`).
 * 3. In `'heuristic'` mode, remaining vanished `pending:*` rows are matched to
 *    unclaimed new booked transactions with the exact same amount and a date
 *    within [-1, +7] days, but ONLY when the match is an unambiguous 1-to-1 pair.
 * 4. Any remaining vanished `pending:*` rows are scheduled for deletion (when
 *    `canPrune` is true) so settled/cancelled holds never leave duplicates.
 */
export function planPendingReconciliation(
  options: PendingReconciliationOptions
): PendingReconciliationPlan {
  const {
    bookedTxns,
    pendingTxns,
    existing,
    mode,
    isCard = false,
    canPrune = true,
  } = options;

  const promotions: ImportedIdMigration[] = [];
  const deletions: string[] = [];

  const pendingRows = existing.filter(
    (r): r is ExistingImport & { imported_id: string } =>
      typeof r.imported_id === 'string' && r.imported_id.startsWith(PENDING_PREFIX)
  );
  if (pendingRows.length === 0) return { promotions, deletions };

  const usedImportedIds = new Set<string>();
  for (const r of existing) {
    if (r.imported_id) usedImportedIds.add(r.imported_id);
  }

  const activePending = mode === 'off' ? [] : filterPendingTransactions(bookedTxns, pendingTxns);
  const activeRawIds = new Set<string>();
  for (const p of activePending) {
    activeRawIds.add(importedIdForTxn(p));
    activeRawIds.add(p.transaction_id);
  }

  const vanishedRows: (ExistingImport & { imported_id: string })[] = [];
  for (const row of pendingRows) {
    const rawId = row.imported_id.slice(PENDING_PREFIX.length);
    if (mode !== 'off' && activeRawIds.has(rawId)) {
      continue;
    }
    vanishedRows.push(row);
  }

  if (vanishedRows.length === 0) return { promotions, deletions };

  const bookedByRawId = new Map<string, TrueLayerTransaction>();
  for (const t of bookedTxns) {
    const stable = importedIdForTxn(t);
    if (!bookedByRawId.has(stable)) bookedByRawId.set(stable, t);
    if (!bookedByRawId.has(t.transaction_id)) bookedByRawId.set(t.transaction_id, t);
  }

  const promotedRowIds = new Set<string>();

  // Pass 1: Deterministic exact ID match (`pending:<id>` -> `<booked_id>`).
  for (const row of vanishedRows) {
    const rawId = row.imported_id.slice(PENDING_PREFIX.length);
    const match = bookedByRawId.get(rawId);
    if (!match) continue;
    const targetId = importedIdForTxn(match);
    if (usedImportedIds.has(targetId)) continue;
    promotions.push({ id: row.id, imported_id: targetId });
    usedImportedIds.add(targetId);
    promotedRowIds.add(row.id);
  }

  // Pass 2: Unambiguous 1-to-1 heuristic match (amount + date window).
  if (mode === 'heuristic') {
    const remainingRows = vanishedRows.filter(
      (r) => !promotedRowIds.has(r.id) && typeof r.amount === 'number' && typeof r.date === 'string'
    );
    const unclaimedBooked = bookedTxns.filter((t) => !usedImportedIds.has(importedIdForTxn(t)));

    if (remainingRows.length > 0 && unclaimedBooked.length > 0) {
      const bookedMeta = unclaimedBooked.map((t) => ({
        txn: t,
        importedId: importedIdForTxn(t),
        date: t.timestamp.split('T')[0],
        amount: Math.round((isCard ? -t.amount : t.amount) * 100),
      }));

      const candidatesByRow = new Map<string, typeof bookedMeta>();
      const rowMatchCountByBookedId = new Map<string, number>();

      for (const row of remainingRows) {
        const matches = bookedMeta.filter((b) => {
          if (b.amount !== row.amount) return false;
          const diff = daysBetween(row.date!, b.date);
          return diff >= -1 && diff <= MAX_SETTLEMENT_DAYS;
        });
        candidatesByRow.set(row.id, matches);
        for (const m of matches) {
          rowMatchCountByBookedId.set(
            m.importedId,
            (rowMatchCountByBookedId.get(m.importedId) ?? 0) + 1
          );
        }
      }

      for (const row of remainingRows) {
        const matches = candidatesByRow.get(row.id) ?? [];
        if (matches.length !== 1) continue;
        const candidate = matches[0];
        if (rowMatchCountByBookedId.get(candidate.importedId) !== 1) continue;
        if (usedImportedIds.has(candidate.importedId)) continue;

        promotions.push({ id: row.id, imported_id: candidate.importedId });
        usedImportedIds.add(candidate.importedId);
        promotedRowIds.add(row.id);
      }
    }
  }

  // Pass 3: Prune vanished pending rows that were not promoted.
  if (canPrune) {
    for (const row of vanishedRows) {
      if (!promotedRowIds.has(row.id)) {
        deletions.push(row.id);
      }
    }
  }

  return { promotions, deletions };
}

// ---------------------------------------------------------------------------
// Sync hooks (called by src/commands/sync.ts)
// ---------------------------------------------------------------------------

interface CachedPendingFetch {
  pendingTxns: TrueLayerTransaction[];
  pendingFetched: boolean;
}

const fetchedPendingCache = new Map<string, CachedPendingFetch>();

function cacheKey(item: { connectionId: string; truelayerAccountId: string }): string {
  return `${item.connectionId}__${item.truelayerAccountId}`;
}

export async function fetchPendingForItem(
  accessToken: string,
  item: {
    connectionId: string;
    truelayerAccountId: string;
    accountKind: 'account' | 'card';
    name: string;
    from: string;
    to: string;
  }
): Promise<void> {
  const mode = pendingModeOf({ truelayerAccountId: item.truelayerAccountId });
  const key = cacheKey(item);
  if (mode === 'off') {
    fetchedPendingCache.delete(key);
    return;
  }
  try {
    const pendingTxns = await fetchPendingTransactions(
      accessToken,
      item.truelayerAccountId,
      item.from,
      item.to,
      item.accountKind === 'card'
    );
    logger.info(`[${item.name}] Fetched ${pendingTxns.length} pending transaction(s)`);
    fetchedPendingCache.set(key, { pendingTxns, pendingFetched: true });
  } catch (err) {
    logger.warn(
      `[${item.name}] Could not fetch pending transactions (continuing with booked only):`,
      describeError(err)
    );
    fetchedPendingCache.set(key, { pendingTxns: [], pendingFetched: false });
  }
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

export async function applyPendingSync(
  account: Account,
  label: string,
  bookedTxns: TrueLayerTransaction[],
  from: string,
  to: string
): Promise<TrueLayerTransaction[]> {
  const mode = pendingModeOf(account);
  const cached = fetchedPendingCache.get(cacheKey(account)) ?? {
    pendingTxns: [],
    pendingFetched: false,
  };
  const activePending =
    mode === 'off' ? [] : filterPendingTransactions(bookedTxns, cached.pendingTxns);

  try {
    const api = require('@actual-app/api') as {
      getTransactions?: (
        accountId: string,
        from: string,
        to: string
      ) => Promise<ExistingImport[]>;
      updateTransaction?: (id: string, fields: { imported_id: string }) => Promise<void>;
      deleteTransaction?: (id: string) => Promise<void>;
    };

    if (api.getTransactions) {
      const existing = await api.getTransactions(
        account.actualAccountId,
        shiftDate(from, -7),
        shiftDate(to, 7)
      );
      const plan = planPendingReconciliation({
        bookedTxns,
        pendingTxns: activePending,
        existing,
        mode,
        isCard: account.accountKind === 'card',
        canPrune: mode === 'off' ? true : cached.pendingFetched,
      });
      if (api.updateTransaction) {
        for (const m of plan.promotions) {
          await api.updateTransaction(m.id, { imported_id: m.imported_id });
        }
      }
      if (api.deleteTransaction) {
        for (const id of plan.deletions) {
          await api.deleteTransaction(id);
        }
      }
      if (plan.promotions.length > 0 || plan.deletions.length > 0) {
        logger.info(
          `[${label}] Reconciled pending transactions: ` +
            `${plan.promotions.length} promoted, ${plan.deletions.length} removed`
        );
      }
    }
  } catch (err) {
    logger.warn(
      `[${label}] Could not reconcile pending transactions (import continues):`,
      describeError(err)
    );
  }

  if (mode === 'off' || activePending.length === 0) return bookedTxns;
  logger.info(`[${label}] Including ${activePending.length} pending transaction(s) (${mode})`);
  return [...bookedTxns, ...stampPendingTransactions(activePending)];
}

// ---------------------------------------------------------------------------
// Dashboard HTML + Express middleware (called by src/web/server.ts)
// ---------------------------------------------------------------------------

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function pendingFieldName(truelayerAccountId: string): string {
  return `pending_${truelayerAccountId}`;
}

const PENDING_OPTIONS: { value: PendingMode; label: string }[] = [
  { value: 'off', label: 'Off (booked only)' },
  { value: 'deterministic', label: 'Deterministic (exact ID)' },
  { value: 'heuristic', label: 'Heuristic (amount & date)' },
];

export function renderPendingControls(
  truelayerAccountId: string,
  accountName: string,
  current: PendingMode = 'off'
): string {
  const name = escapeAttr(pendingFieldName(truelayerAccountId));
  const legend = escapeAttr(`Pending transactions for ${accountName}`);
  const items = PENDING_OPTIONS.map((o) => {
    const checked = o.value === current ? ' checked' : '';
    return (
      `<label style="display:block;font-size:0.9em;white-space:nowrap">` +
      `<input type="radio" name="${name}" value="${escapeAttr(o.value)}"${checked}> ` +
      `${escapeAttr(o.label)}</label>`
    );
  }).join('');
  return `<div role="radiogroup" aria-label="${legend}">${items}</div>`;
}

export function parsePendingFields(
  body: Record<string, unknown> | undefined
): Map<string, PendingMode> {
  const out = new Map<string, PendingMode>();
  for (const key of Object.keys(body ?? {})) {
    if (!key.startsWith('pending_')) continue;
    const truelayerAccountId = key.slice('pending_'.length);
    if (!truelayerAccountId) continue;
    const raw = (body as Record<string, unknown>)[key];
    const val = typeof raw === 'string' ? raw.trim() : '';
    if (isPendingMode(val)) {
      out.set(truelayerAccountId, val);
    }
  }
  return out;
}

/**
 * Injects the Pending column into pairing / edit-pairings HTML tables so
 * `src/web/pages.ts` does not need to be modified at all.
 */
export function injectPendingColumnHtml(
  html: string,
  modes: Record<string, PendingMode> = loadPendingModes()
): string {
  if (!html.includes('<thead><tr><th>TrueLayer</th><th>Actual account</th></tr></thead>')) {
    return html;
  }
  const withHeader = html.replace(
    '<thead><tr><th>TrueLayer</th><th>Actual account</th></tr></thead>',
    '<thead><tr><th>TrueLayer</th><th>Actual account</th><th>Pending</th></tr></thead>'
  );
  return withHeader.replace(/<tr>([\s\S]*?)<\/tr>/g, (fullRow, inner: string) => {
    if (inner.includes('<th>')) return fullRow;
    const match = inner.match(/name="map_([^"]+?)(?:__[^"]+)"/);
    if (!match) {
      return `<tr>${inner}<td><span class="muted">—</span></td></tr>`;
    }
    const rawTlId = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const mode = modes[rawTlId] ?? 'off';
    return `<tr>${inner}<td>${renderPendingControls(rawTlId, rawTlId, mode)}</td></tr>`;
  });
}

export function installPendingMiddleware(app: Express): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isPairingPost =
      req.method === 'POST' &&
      (req.path === '/pair' || /^\/connections\/[^/]+\/pairings$/.test(req.path));
    if (isPairingPost) {
      const parsed = parsePendingFields(req.body as Record<string, unknown> | undefined);
      if (parsed.size > 0) {
        updatePendingModes(parsed).then(
          () => next(),
          (err) => next(err)
        );
        return;
      }
    }

    const isPairingGet =
      req.method === 'GET' &&
      (/^\/pair\/[^/]+$/.test(req.path) || /^\/connections\/[^/]+\/pairings$/.test(req.path));
    if (isPairingGet) {
      const origSend = res.send.bind(res);
      res.send = ((body?: unknown) => {
        if (typeof body === 'string') {
          return origSend(injectPendingColumnHtml(body));
        }
        return origSend(body);
      }) as Response['send'];
    }
    next();
  });
}
