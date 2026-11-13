import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// Mock @actual-app/api before importing modules that transitively load it.
const mockAmountToInteger = (n: number): number => Math.round(n * 100);
const require = createRequire(import.meta.url);
try {
  const resolvedApiPath = require.resolve('@actual-app/api');
  require.cache[resolvedApiPath] = {
    id: resolvedApiPath,
    filename: resolvedApiPath,
    loaded: true,
    parent: null,
    children: [],
    path: '',
    paths: [],
    exports: {
      utils: {
        amountToInteger: mockAmountToInteger,
      },
    },
  } as unknown as NodeJS.Module;
} catch {
  // Handled by ESM loader when running without node_modules
}

const { mapTransaction } = await import('../src/mapper.js');
const {
  pendingImportedIdFor,
  filterPendingTransactions,
  planPendingReconciliation,
  renderPendingControls,
  parsePendingFields,
} = await import('../src/pending.js');
const { applyPairingChanges } = await import('../src/config.js');
const { planFetches } = await import('../src/commands/sync.js');
const { pairingPage, editPairingsPage } = await import('../src/web/pages.js');

import type { TrueLayerTransaction } from '../src/clients/truelayer.js';
import type { Account } from '../src/config.js';

function makeTransaction(
  overrides: Partial<TrueLayerTransaction> = {}
): TrueLayerTransaction {
  return {
    transaction_id: 'txn-001',
    timestamp: '2024-03-15T10:30:00Z',
    amount: -12.5,
    currency: 'GBP',
    transaction_type: 'debit',
    transaction_classification: ['Shopping'],
    description: 'TESCO SUPERSTORE',
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    name: 'Acct',
    connectionId: 'conn',
    budgetId: 'default',
    accountKind: 'account',
    truelayerAccountId: 'tl-1',
    actualAccountId: 'actual-1',
    currency: 'GBP',
    ...overrides,
  };
}

describe('pending transactions (prefix, filtering, reconciliation)', () => {
  it('prefixes imported_id with pending: when status is pending', () => {
    const t = makeTransaction({
      transaction_id: 'tl-99',
      normalised_provider_transaction_id: 'stable-99',
      status: 'pending',
    });
    assert.equal(pendingImportedIdFor(t), 'pending:stable-99');
    const mapped = mapTransaction(t);
    assert.equal(mapped.imported_id, 'pending:stable-99');
    assert.equal(mapped.cleared, false);
  });

  it('filterPendingTransactions drops pending items that are already in the booked list', () => {
    const booked = [
      makeTransaction({ transaction_id: 'b1', normalised_provider_transaction_id: 's1' }),
      makeTransaction({ transaction_id: 'b2' }),
    ];
    const pending = [
      makeTransaction({ transaction_id: 'p1', normalised_provider_transaction_id: 's1', status: 'pending' }),
      makeTransaction({ transaction_id: 'b2', status: 'pending' }),
      makeTransaction({ transaction_id: 'p3', status: 'pending' }),
    ];
    const active = filterPendingTransactions(booked, pending);
    assert.deepEqual(active.map((t) => t.transaction_id), ['p3']);
  });

  it('mode=off deletes all existing pending:* rows when canPrune is true', () => {
    const plan = planPendingReconciliation({
      mode: 'off',
      bookedTxns: [],
      pendingTxns: [],
      existing: [
        { id: 'r1', imported_id: 'pending:p1', date: '2026-06-10', amount: -1000 },
        { id: 'r2', imported_id: 'booked-1', date: '2026-06-10', amount: -1000 },
      ],
      isCard: false,
      canPrune: true,
    });
    assert.deepEqual(plan, { promotions: [], deletions: ['r1'] });
  });

  it('does not delete vanished pending rows when canPrune is false (pending endpoint failed)', () => {
    const plan = planPendingReconciliation({
      mode: 'deterministic',
      bookedTxns: [],
      pendingTxns: [],
      existing: [{ id: 'r1', imported_id: 'pending:p1', date: '2026-06-10', amount: -1000 }],
      isCard: false,
      canPrune: false,
    });
    assert.deepEqual(plan, { promotions: [], deletions: [] });
  });

  it('deterministic mode promotes exact ID matches (stable ID or transaction_id) and deletes vanished unmatched pending rows', () => {
    const booked = [
      makeTransaction({ transaction_id: 'tl-new-1', normalised_provider_transaction_id: 's1', amount: -12.5 }),
      makeTransaction({ transaction_id: 'tl-other', amount: -15.0 }),
    ];
    const activePending = [
      makeTransaction({ transaction_id: 'still-pending', status: 'pending' }),
    ];
    const existing = [
      { id: 'row-match', imported_id: 'pending:tl-new-1', date: '2024-03-14', amount: -1250 },
      { id: 'row-active', imported_id: 'pending:still-pending', date: '2024-03-15', amount: -500 },
      { id: 'row-vanished', imported_id: 'pending:old-pending-id', date: '2024-03-14', amount: -1500 },
    ];
    const plan = planPendingReconciliation({
      mode: 'deterministic',
      bookedTxns: booked,
      pendingTxns: activePending,
      existing,
      isCard: false,
      canPrune: true,
    });
    assert.deepEqual(plan.promotions, [{ id: 'row-match', imported_id: 's1' }]);
    assert.deepEqual(plan.deletions, ['row-vanished']);
  });

  it('heuristic mode promotes unambiguous 1-to-1 amount + date window matches and deletes ambiguous ones', () => {
    const booked = [
      makeTransaction({ transaction_id: 'b-single', timestamp: '2024-03-17T10:00:00Z', amount: -12.5 }),
      makeTransaction({ transaction_id: 'b-coffee-1', timestamp: '2024-03-16T09:00:00Z', amount: -5.0 }),
      makeTransaction({ transaction_id: 'b-coffee-2', timestamp: '2024-03-16T10:00:00Z', amount: -5.0 }),
      makeTransaction({ transaction_id: 'b-late', timestamp: '2024-03-26T10:00:00Z', amount: -99.0 }),
    ];
    const existing = [
      { id: 'row-single', imported_id: 'pending:p-single', date: '2024-03-15', amount: -1250 },
      { id: 'row-coffee', imported_id: 'pending:p-coffee', date: '2024-03-15', amount: -500 },
      { id: 'row-late', imported_id: 'pending:p-late', date: '2024-03-15', amount: -9900 },
    ];
    const plan = planPendingReconciliation({
      mode: 'heuristic',
      bookedTxns: booked,
      pendingTxns: [],
      existing,
      isCard: false,
      canPrune: true,
    });
    assert.deepEqual(plan.promotions, [{ id: 'row-single', imported_id: 'b-single' }]);
    assert.deepEqual(plan.deletions.sort(), ['row-coffee', 'row-late']);
  });

  it('heuristic mode respects card sign negation (isCard=true)', () => {
    const booked = [
      makeTransaction({ transaction_id: 'card-booked-1', timestamp: '2024-03-16T12:00:00Z', amount: 25.0 }),
    ];
    const existing = [
      { id: 'row-card-pending', imported_id: 'pending:card-pend-1', date: '2024-03-15', amount: -2500 },
    ];
    const plan = planPendingReconciliation({
      mode: 'heuristic',
      bookedTxns: booked,
      pendingTxns: [],
      existing,
      isCard: true,
      canPrune: true,
    });
    assert.deepEqual(plan.promotions, [{ id: 'row-card-pending', imported_id: 'card-booked-1' }]);
    assert.deepEqual(plan.deletions, []);
  });
});

describe('pending config, sync planning, and UI controls', () => {
  it('updates pendingSync and removes the key when set back to off', () => {
    const accounts = [makeAccount({ connectionId: 'conn', budgetId: 'default', actualAccountId: 'a1' })];

    const step1 = applyPairingChanges(accounts, 'conn', {
      'tl-1__default': { actualAccountId: 'a1', pendingSync: 'heuristic' },
    });
    assert.equal(step1.changed, 1);
    assert.equal(step1.accounts[0].pendingSync, 'heuristic');

    const step2 = applyPairingChanges(step1.accounts, 'conn', {
      'tl-1__default': { actualAccountId: 'a1', pendingSync: 'off' },
    });
    assert.equal(step2.changed, 1);
    assert.equal(step2.accounts[0].pendingSync, undefined);
  });

  it('sets includePending=true in planFetches when any mapping for a bank account has pendingSync enabled', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    const plan = planFetches(
      [
        makeAccount({ truelayerAccountId: 'tl-1', budgetId: 'default' }),
        makeAccount({ truelayerAccountId: 'tl-1', budgetId: 'budget_1', pendingSync: 'deterministic' }),
        makeAccount({ truelayerAccountId: 'tl-2', budgetId: 'default', pendingSync: 'off' }),
      ],
      7,
      now
    );
    assert.equal(plan.find((p) => p.truelayerAccountId === 'tl-1')!.includePending, true);
    assert.equal(plan.find((p) => p.truelayerAccountId === 'tl-2')!.includePending, undefined);
  });

  it('parses pending_<tl> form fields and renders radio controls without adding <select> elements', () => {
    assert.deepEqual(
      [...parsePendingFields({ pending_tl1: 'heuristic', pending_tl2: 'invalid', pending_: 'off' }).entries()],
      [['tl1', 'heuristic']]
    );

    const html = renderPendingControls('tl1', 'Current', 'deterministic');
    assert.equal(html.includes('<select'), false);
    assert.match(html, /name="pending_tl1" value="deterministic" checked/);

    const budgetAccounts = [
      {
        budget: { id: 'b1', name: 'Personal', syncId: 's1' },
        accounts: [{ id: 'a1', name: 'Current', offbudget: false, closed: false }],
      },
    ];
    const editHtml = editPairingsPage({
      connectionId: 'conn_1',
      provider: 'Monzo',
      budgetAccounts,
      rows: [
        {
          truelayerAccountId: 'tl1',
          name: 'Bank',
          accountKind: 'account',
          currency: 'GBP',
          targets: { b1: 'a1' },
          pendingSync: 'heuristic',
        },
      ],
    });
    assert.match(editHtml, /name="pending_tl1" value="heuristic" checked/);

    const pairHtml = pairingPage({
      pairingId: 'p1',
      provider: 'Monzo',
      budgetAccounts,
      items: [{ truelayerAccountId: 'tl1', name: 'Bank', accountKind: 'account', currency: 'GBP' }],
    });
    assert.match(pairHtml, /name="pending_tl1" value="off" checked/);
  });
});
