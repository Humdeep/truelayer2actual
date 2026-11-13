import {
  fetchPendingTransactions,
  fetchCardPendingTransactions,
  type TrueLayerTransaction,
} from './clients/truelayer.js';
import type { ExistingImport, ImportedIdMigration } from './mapper.js';
import {
  PENDING_MODES,
  isPendingMode,
  pendingModeOf,
  type Account,
  type PendingMode,
} from './config.js';
import { describeError } from './util/errors.js';
import { logger } from './logger.js';

export { PENDING_MODES, isPendingMode, pendingModeOf, type PendingMode };

export const PENDING_PREFIX = 'pending:';

const MAX_SETTLEMENT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

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

  // Identify rows that are still pending at the bank.
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

  // Index booked transactions by both their stable ID and raw transaction_id.
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

/**
 * Fetch pending transactions for a TrueLayer account/card when `includePending`
 * is enabled on the fetch plan item. Failures are logged and treated as
 * `pendingFetched: false` so booked sync continues without pruning existing pending rows.
 */
export async function fetchPendingForPlanItem(
  accessToken: string,
  item: {
    accountKind: 'account' | 'card';
    truelayerAccountId: string;
    name: string;
    from: string;
    to: string;
    includePending?: boolean;
  }
): Promise<{ pendingTxns: TrueLayerTransaction[]; pendingFetched: boolean }> {
  if (!item.includePending) return { pendingTxns: [], pendingFetched: false };
  try {
    const pendingTxns =
      item.accountKind === 'card'
        ? await fetchCardPendingTransactions(accessToken, item.truelayerAccountId, item.from, item.to)
        : await fetchPendingTransactions(accessToken, item.truelayerAccountId, item.from, item.to);
    logger.info(`[${item.name}] Fetched ${pendingTxns.length} pending transaction(s)`);
    return { pendingTxns, pendingFetched: true };
  } catch (err) {
    logger.warn(
      `[${item.name}] Could not fetch pending transactions (continuing with booked only):`,
      describeError(err)
    );
    return { pendingTxns: [], pendingFetched: false };
  }
}

/**
 * Execute pending transaction promotions and deletions in Actual Budget.
 */
export async function reconcilePendingInActual(
  account: Account,
  label: string,
  bookedTxns: TrueLayerTransaction[],
  pendingTxns: TrueLayerTransaction[],
  pendingFetched: boolean,
  existing: ExistingImport[],
  ops: {
    setActualImportedId: (id: string, importedId: string) => Promise<void>;
    deleteActualTransaction: (id: string) => Promise<void>;
  }
): Promise<void> {
  const mode = pendingModeOf(account);
  const pendingPlan = planPendingReconciliation({
    bookedTxns,
    pendingTxns,
    existing,
    mode,
    isCard: account.accountKind === 'card',
    canPrune: mode === 'off' ? true : pendingFetched,
  });
  for (const m of pendingPlan.promotions) await ops.setActualImportedId(m.id, m.imported_id);
  for (const id of pendingPlan.deletions) await ops.deleteActualTransaction(id);
  if (pendingPlan.promotions.length > 0 || pendingPlan.deletions.length > 0) {
    logger.info(
      `[${label}] Reconciled pending transactions: ` +
        `${pendingPlan.promotions.length} promoted, ${pendingPlan.deletions.length} removed`
    );
  }
}

// ---------------------------------------------------------------------------
// Dashboard HTML + form helpers (kept here to minimize diffs in web/*.ts)
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

/**
 * Render radio controls for choosing the per-account pending transaction mode.
 * Uses `<input type="radio">` rather than `<select>` so existing upstream tests
 * that count `<select>` elements on pairing pages remain 100% unaffected.
 */
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

/**
 * Parse `pending_<truelayerAccountId>` form fields into valid PendingMode values.
 */
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
