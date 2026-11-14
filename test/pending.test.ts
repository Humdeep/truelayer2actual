import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { once } from 'events';
import axios from 'axios';
import { createRequire } from 'module';

// Mock @actual-app/api before importing modules that transitively load it.
const mockAmountToInteger = (n: number): number => Math.round(n * 100);
const actualMock = {
  existing: [] as { id: string; imported_id?: string; date?: string; amount?: number }[],
  updates: [] as { id: string; fields: Record<string, unknown> }[],
  deletes: [] as string[],
};
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
      getTransactions: async () => actualMock.existing,
      updateTransaction: async (id: string, fields: Record<string, unknown>) => {
        actualMock.updates.push({ id, fields });
      },
      deleteTransaction: async (id: string) => {
        actualMock.deletes.push(id);
      },
    },
  } as unknown as NodeJS.Module;
} catch {
  // Handled by ESM loader when running without node_modules
}

const { mapTransaction } = await import('../src/mapper.js');
const {
  pendingImportedIdFor,
  stampPendingTransactions,
  filterPendingTransactions,
  planPendingReconciliation,
  renderPendingControls,
  parsePendingFields,
  injectPendingColumnHtml,
  setPendingPathForTests,
  loadPendingModes,
  updatePendingModes,
  pendingModeOf,
  installPendingMiddleware,
  fetchPendingForItem,
  applyPendingSync,
} = await import('../src/pending.js');
const { pairingPage, editPairingsPage } = await import('../src/web/pages.js');
const { setConfigPathForTests } = await import('../src/config.js');
const { setTokensPathForTests, saveConnection } = await import('../src/auth/tokens.js');
const { setPairing } = await import('../src/web/oauth.js');
const { createApp } = await import('../src/web/server.js');

import type { TrueLayerTransaction } from '../src/clients/truelayer.js';
import type { Express } from 'express';

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

describe('pending transactions (stamping, filtering, reconciliation)', () => {
  it('stamps pending transactions so unmodified mapTransaction produces pending: imported_id and cleared=false', () => {
    const raw = makeTransaction({
      transaction_id: 'tl-99',
      normalised_provider_transaction_id: 'stable-99',
    });
    assert.equal(pendingImportedIdFor(raw), 'pending:stable-99');

    const [stamped] = stampPendingTransactions([raw]);
    const mapped = mapTransaction(stamped);
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

describe('pending sidecar storage and HTML middleware injection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl2a-pending-'));
    setPendingPathForTests(path.join(tmpDir, 'pending.json'));
  });

  afterEach(() => {
    setPendingPathForTests(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists per-account pending modes in data/pending.json and cleans up off entries', async () => {
    assert.deepEqual(loadPendingModes(), {});
    assert.equal(pendingModeOf('tl1'), 'off');

    const modes1 = await updatePendingModes(new Map([['tl1', 'heuristic']]));
    assert.deepEqual(modes1, { tl1: 'heuristic' });
    assert.equal(pendingModeOf('tl1'), 'heuristic');

    const modes2 = await updatePendingModes(new Map([['tl1', 'off']]));
    assert.deepEqual(modes2, {});
    assert.equal(pendingModeOf('tl1'), 'off');
    assert.deepEqual(loadPendingModes(), {});
  });

  it('parses pending_<tl> form fields and injects radio controls into pairingPage and editPairingsPage without adding <select> elements', async () => {
    assert.deepEqual(
      [...parsePendingFields({ pending_tl1: 'heuristic', pending_tl2: 'invalid', pending_: 'off' }).entries()],
      [['tl1', 'heuristic']]
    );

    const html = renderPendingControls('tl1', 'Current', 'deterministic');
    assert.equal(html.includes('<select'), false);
    assert.match(html, /name="pending_tl1" value="deterministic" checked/);

    await updatePendingModes(new Map([['tl1', 'heuristic']]));

    const budgetAccounts = [
      {
        budget: { id: 'b1', name: 'Personal', syncId: 's1' },
        accounts: [{ id: 'a1', name: 'Current', offbudget: false, closed: false }],
      },
    ];
    const editHtml = injectPendingColumnHtml(
      editPairingsPage({
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
          },
        ],
      })
    );
    assert.match(editHtml, /<th>Pending<\/th>/);
    assert.match(editHtml, /name="pending_tl1" value="heuristic" checked/);

    const pairHtml = injectPendingColumnHtml(
      pairingPage({
        pairingId: 'p1',
        provider: 'Monzo',
        budgetAccounts,
        items: [{ truelayerAccountId: 'tl2', name: 'Card', accountKind: 'card', currency: 'GBP' }],
      })
    );
    assert.match(pairHtml, /<th>Pending<\/th>/);
    assert.match(pairHtml, /name="pending_tl2" value="off" checked/);
  });
});

// ---------------------------------------------------------------------------
// Middleware: saving pending modes alongside the upstream pairing routes
// ---------------------------------------------------------------------------

type Handler = (req: unknown, res: unknown, next: () => void) => void;

function captureMiddleware(): Handler {
  let handler: Handler | undefined;
  installPendingMiddleware({ use: (fn: Handler) => (handler = fn) } as unknown as Express);
  return handler!;
}

/** Run the middleware, then let the "route" respond via `respond(res)`. */
async function runPost(
  handler: Handler,
  reqPath: string,
  body: Record<string, unknown>,
  respond: (res: { redirect: (url: string) => void; send: (b: string) => void }) => void
): Promise<{ redirectedTo?: string; sent?: string }> {
  const out: { redirectedTo?: string; sent?: string } = {};
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const res = {
    redirect: (url: string) => {
      out.redirectedTo = url;
      done();
    },
    send: (b: string) => {
      out.sent = b;
      done();
    },
  };
  handler({ method: 'POST', path: reqPath, body }, res, () => respond(res));
  await finished;
  return out;
}

describe('pending middleware', () => {
  let tmpDir: string;
  const handler = captureMiddleware();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl2a-pending-mw-'));
    setPendingPathForTests(path.join(tmpDir, 'pending.json'));
    setConfigPathForTests(path.join(tmpDir, 'config.json'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        budgets: [{ id: 'b1', name: 'Personal', syncId: 's1' }],
        accounts: [
          { name: 'A', connectionId: 'c1', budgetId: 'b1', accountKind: 'account', truelayerAccountId: 'tlA', actualAccountId: 'a1', currency: 'GBP' },
          { name: 'O', connectionId: 'c2', budgetId: 'b1', accountKind: 'account', truelayerAccountId: 'tlOther', actualAccountId: 'a2', currency: 'GBP' },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      })
    );
  });

  afterEach(() => {
    setPendingPathForTests(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves after a successful edit, only for accounts on that connection', async () => {
    const out = await runPost(
      handler,
      '/connections/c1/pairings',
      { pending_tlA: 'heuristic', pending_tlOther: 'deterministic' },
      (res) => res.redirect('/connections/c1/pairings?msg=ok')
    );
    assert.equal(out.redirectedTo, '/connections/c1/pairings?msg=ok');
    assert.deepEqual(loadPendingModes(), { tlA: 'heuristic' });
  });

  it('does not save when the route fails (error redirect or 4xx page)', async () => {
    await runPost(handler, '/connections/c1/pairings', { pending_tlA: 'heuristic' }, (res) =>
      res.redirect('/?err=boom')
    );
    await runPost(handler, '/connections/nope/pairings', { pending_tlA: 'heuristic' }, (res) =>
      res.send('Unknown connection')
    );
    assert.deepEqual(loadPendingModes(), {});
  });

  it('POST /pair saves only for accounts in a valid pairing session', async () => {
    const pairingId = setPairing({
      connectionId: 'c1',
      mode: 'new',
      provider: 'Test',
      items: [{ truelayerAccountId: 'tlA', name: 'A', accountKind: 'account', currency: 'GBP' }],
    });
    await runPost(
      handler,
      '/pair',
      { pairingId, pending_tlA: 'deterministic', pending_tlOther: 'heuristic' },
      (res) => res.redirect('/?msg=saved')
    );
    assert.deepEqual(loadPendingModes(), { tlA: 'deterministic' });

    await runPost(handler, '/pair', { pairingId: 'expired', pending_tlA: 'heuristic' }, (res) =>
      res.redirect('/?msg=saved')
    );
    assert.deepEqual(loadPendingModes(), { tlA: 'deterministic' });
  });

  it('drops modes for accounts that are no longer paired after a connection is deleted', async () => {
    await updatePendingModes(new Map([['tlA', 'heuristic'], ['tlGone', 'heuristic']]));
    await runPost(handler, '/connections/c9/delete', {}, (res) => res.redirect('/?msg=deleted'));
    assert.deepEqual(loadPendingModes(), { tlA: 'heuristic' });
  });

  it('injects the column into pairing pages via res.send, using the account name for the label', () => {
    let sent = '';
    const res = { send: (b: string) => (sent = b) };
    handler({ method: 'GET', path: '/connections/c1/pairings', body: {} }, res, () => {
      (res.send as (b: string) => void)(
        editPairingsPage({
          connectionId: 'c1',
          provider: 'Monzo',
          budgetAccounts: [
            {
              budget: { id: 'b1', name: 'Personal', syncId: 's1' },
              accounts: [{ id: 'a1', name: 'Current', offbudget: false, closed: false }],
            },
            {
              budget: { id: 'b2', name: 'Joint', syncId: 's2' },
              accounts: [{ id: 'a9', name: 'Joint', offbudget: false, closed: false }],
            },
          ],
          rows: [
            { truelayerAccountId: 'tlA', name: 'My Bank', accountKind: 'account', currency: 'GBP', targets: { b1: 'a1' } },
          ],
        })
      );
    });
    assert.match(sent, /<th>Pending<\/th>/);
    assert.equal((sent.match(/name="pending_tlA"/g) ?? []).length, 3);
    assert.match(sent, /aria-label="Pending transactions for My Bank"/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end sync hook: fetch pending → reconcile in Actual → rows to import
// ---------------------------------------------------------------------------

describe('pending sync hooks', () => {
  let tmpDir: string;
  const account = {
    name: 'Current',
    connectionId: 'c1',
    budgetId: 'b1',
    accountKind: 'account' as const,
    truelayerAccountId: 'tlA',
    actualAccountId: 'actual-1',
    currency: 'GBP',
  };
  const item = { ...account, from: '2024-03-10', to: '2024-03-20' };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl2a-pending-sync-'));
    setPendingPathForTests(path.join(tmpDir, 'pending.json'));
    actualMock.existing = [];
    actualMock.updates = [];
    actualMock.deletes = [];
  });

  afterEach(() => {
    mock.restoreAll();
    setPendingPathForTests(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('promotes a settled pending row (marking it cleared), deletes a vanished one, and imports still-pending ones', async () => {
    await updatePendingModes(new Map([['tlA', 'deterministic']]));
    mock.method(axios, 'get', async () => ({
      data: { results: [makeTransaction({ transaction_id: 'still', amount: -3 })] },
    }));
    actualMock.existing = [
      { id: 'row-settled', imported_id: 'pending:s1', date: '2024-03-14', amount: -1250 },
      { id: 'row-gone', imported_id: 'pending:gone', date: '2024-03-14', amount: -999 },
      { id: 'row-still', imported_id: 'pending:still', date: '2024-03-15', amount: -300 },
    ];
    const booked = [makeTransaction({ transaction_id: 'tl-new', normalised_provider_transaction_id: 's1' })];

    await fetchPendingForItem('token', item);
    const all = await applyPendingSync(account, 'Current', booked, item.from, item.to);

    assert.deepEqual(actualMock.updates, [{ id: 'row-settled', fields: { imported_id: 's1', cleared: true } }]);
    assert.deepEqual(actualMock.deletes, ['row-gone']);
    const mapped = all.map((t) => mapTransaction(t));
    assert.deepEqual(
      mapped.map((m) => [m.imported_id, m.cleared]),
      [['s1', true], ['pending:still', false]]
    );
  });

  it('never deletes pending rows when the pending fetch failed', async () => {
    await updatePendingModes(new Map([['tlA', 'heuristic']]));
    mock.method(axios, 'get', async () => {
      throw new Error('timeout');
    });
    actualMock.existing = [{ id: 'row-p', imported_id: 'pending:p1', date: '2024-03-14', amount: -500 }];

    await fetchPendingForItem('token', item);
    const all = await applyPendingSync(account, 'Current', [], item.from, item.to);

    assert.deepEqual(actualMock.deletes, []);
    assert.deepEqual(all, []);
  });

  it('mode off: does not call TrueLayer, and cleans up leftover pending rows', async () => {
    const get = mock.method(axios, 'get', async () => ({ data: { results: [] } }));
    actualMock.existing = [{ id: 'row-p', imported_id: 'pending:p1', date: '2024-03-14', amount: -500 }];

    await fetchPendingForItem('token', item);
    const booked = [makeTransaction({ transaction_id: 'b1' })];
    const all = await applyPendingSync(account, 'Current', booked, item.from, item.to);

    assert.equal(get.mock.callCount(), 0);
    assert.deepEqual(actualMock.deletes, ['row-p']);
    assert.deepEqual(all, booked);
  });
});

// ---------------------------------------------------------------------------
// Integration: real Express app (createApp) end-to-end routes
// ---------------------------------------------------------------------------

describe('pending middleware integration with real createApp()', () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl2a-pending-http-'));
    setPendingPathForTests(path.join(tmpDir, 'pending.json'));
    setConfigPathForTests(path.join(tmpDir, 'config.json'));
    setTokensPathForTests(path.join(tmpDir, 'tokens.json'));
    delete process.env.ACTUAL_SYNC_ID;

    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        budgets: [{ id: 'b1', name: 'Personal', syncId: 's1' }],
        accounts: [
          {
            name: 'Current',
            connectionId: 'c1',
            budgetId: 'b1',
            accountKind: 'account',
            truelayerAccountId: 'tlA',
            actualAccountId: 'a1',
            currency: 'GBP',
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      })
    );
    await saveConnection('c1', {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      providerId: 'mock',
      providerDisplayName: 'Monzo',
    });

    server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setPendingPathForTests(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /connections/:id/pairings updates pending.json and POST /connections/:id/delete prunes it', async () => {
    const editRes = await fetch(`${baseUrl}/connections/c1/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ map_tlA__b1: 'a1', pending_tlA: 'heuristic' }),
      redirect: 'manual',
    });
    assert.equal(editRes.status, 302);
    assert.deepEqual(loadPendingModes(), { tlA: 'heuristic' });

    const delRes = await fetch(`${baseUrl}/connections/c1/delete`, {
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(delRes.status, 302);
    assert.deepEqual(loadPendingModes(), {});
  });

  it('POST /pair saves pending mode for a valid pairing session and ignores expired sessions', async () => {
    const badRes = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pairingId: 'missing', pending_tlB: 'heuristic' }),
      redirect: 'manual',
    });
    assert.equal(badRes.status, 400);
    assert.deepEqual(loadPendingModes(), {});

    const pairingId = setPairing({
      connectionId: 'c2',
      mode: 'new',
      provider: 'Starling',
      items: [{ truelayerAccountId: 'tlB', name: 'Joint', accountKind: 'account', currency: 'GBP' }],
    });
    const okRes = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        pairingId,
        map_tlB__b1: 'a2',
        pending_tlB: 'deterministic',
      }),
      redirect: 'manual',
    });
    assert.equal(okRes.status, 302);
    assert.deepEqual(loadPendingModes(), { tlB: 'deterministic' });
  });
});
