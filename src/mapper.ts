import { utils } from '@actual-app/api';
import type { TrueLayerTransaction } from './clients/truelayer.js';
import type { ActualTransaction } from './clients/actual.js';
import type { PendingMode } from './config.js';

export type { ActualTransaction };

export const PENDING_PREFIX = 'pending:';

const MAX_SETTLEMENT_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/**
 * The ID used as Actual's `imported_id`.
 *
 * TrueLayer's `transaction_id` can change when a bank amends a transaction
 * (FX settlement, adjustments, fraud checks), and Actual skips its fuzzy
 * matching when both sides have an imported_id, so a changed ID becomes a
 * duplicate. `normalised_provider_transaction_id` is documented as not subject
 * to change, so prefer it and fall back when the provider doesn't supply it.
 */
export function importedIdFor(t: TrueLayerTransaction): string {
  const stable = t.normalised_provider_transaction_id?.trim();
  return stable ? stable : t.transaction_id;
}

export function pendingImportedIdFor(t: TrueLayerTransaction): string {
  return `${PENDING_PREFIX}${importedIdFor(t)}`;
}

export interface ExistingImport {
  id: string;
  imported_id?: string | null;
  date?: string;
  amount?: number;
}

export interface ImportedIdMigration {
  /** Actual transaction id to update. */
  id: string;
  /** New imported_id (the stable ID). */
  imported_id: string;
}

/**
 * Plan in-place updates so transactions already in Actual under their old
 * `transaction_id` are moved to the stable ID before importing. Without this,
 * switching IDs would re-import every transaction in the lookback window.
 *
 * A row is migrated only when the incoming transaction has a stable ID, no
 * existing row already uses it, and an existing row uses the incoming
 * `transaction_id`. Each existing row is migrated at most once.
 */
export function planImportedIdMigrations(
  txns: TrueLayerTransaction[],
  existing: ExistingImport[]
): ImportedIdMigration[] {
  const rowByImportedId = new Map<string, string>();
  for (const row of existing) {
    if (row.imported_id) rowByImportedId.set(row.imported_id, row.id);
  }

  const migrated = new Set<string>();
  const plan: ImportedIdMigration[] = [];
  for (const t of txns) {
    const stable = importedIdFor(t);
    if (stable === t.transaction_id) continue; // no stable ID, nothing to move
    if (rowByImportedId.has(stable)) continue; // already on the stable ID
    const rowId = rowByImportedId.get(t.transaction_id);
    if (!rowId || migrated.has(rowId)) continue;
    plan.push({ id: rowId, imported_id: stable });
    migrated.add(rowId);
    rowByImportedId.delete(t.transaction_id);
    rowByImportedId.set(stable, rowId);
  }
  return plan;
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
    bookedIds.add(importedIdFor(t));
    bookedIds.add(t.transaction_id);
  }
  return pendingTxns.filter(
    (p) => !bookedIds.has(importedIdFor(p)) && !bookedIds.has(p.transaction_id)
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
    activeRawIds.add(importedIdFor(p));
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
    const stable = importedIdFor(t);
    if (!bookedByRawId.has(stable)) bookedByRawId.set(stable, t);
    if (!bookedByRawId.has(t.transaction_id)) bookedByRawId.set(t.transaction_id, t);
  }

  const promotedRowIds = new Set<string>();

  // Pass 1: Deterministic exact ID match (`pending:<id>` -> `<booked_id>`).
  for (const row of vanishedRows) {
    const rawId = row.imported_id.slice(PENDING_PREFIX.length);
    const match = bookedByRawId.get(rawId);
    if (!match) continue;
    const targetId = importedIdFor(match);
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
    const unclaimedBooked = bookedTxns.filter((t) => !usedImportedIds.has(importedIdFor(t)));

    if (remainingRows.length > 0 && unclaimedBooked.length > 0) {
      const bookedMeta = unclaimedBooked.map((t) => ({
        txn: t,
        importedId: importedIdFor(t),
        date: t.timestamp.split('T')[0],
        amount: utils.amountToInteger(isCard ? -t.amount : t.amount),
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

export function mapTransaction(t: TrueLayerTransaction, isCard = false): ActualTransaction {
  // Extract date portion from ISO 8601 timestamp
  const date = t.timestamp.split('T')[0];

  // TrueLayer returns card purchases as positive amounts (charges to the card),
  // but Actual expects negative amounts for a credit card account (increasing liability).
  const rawAmount = isCard ? -t.amount : t.amount;
  const amount = utils.amountToInteger(rawAmount);

  // Prefer merchant_name, fall back to description
  const payee_name = t.merchant_name ?? t.description;

  // Status is 'booked' | 'pending' when present; anything else counts as cleared.
  const cleared = t.status === undefined ? true : t.status === 'booked';
  const imported_id = t.status === 'pending' ? pendingImportedIdFor(t) : importedIdFor(t);

  return {
    date,
    amount,
    payee_name,
    notes: t.description,
    imported_id,
    cleared,
  };
}
