import { useMemo } from 'react';
import type {
  AttemptPayload,
  BatchPayload,
  BoardRow,
  CampaignPayload,
  CellPayload,
  ItemPayload,
  RulePayload,
} from '../../../src/shared/board';
import { modelFamily } from '../../../src/shared/board';
import type { BatchLearning } from '../../../src/shared/learning';
import { useBoard } from './store';

export interface Item extends ItemPayload {
  key: string;
  rowId: number;
  updatedAt: number;
  firstSeen: number;
}

export interface Attempt extends AttemptPayload {
  key: string;
  rowId: number;
  family: string;
}

export interface Batch extends BatchPayload {
  share: number | null;
  usdPerAccepted: number | null;
  /** The learning loop's numbers for a finished batch, at the campaign's gate. */
  learn: BatchLearning | null;
}

export interface Rule extends RulePayload {
  key: string;
}

export interface Cell extends CellPayload {
  key: string;
  family: string;
}

export interface BoardView {
  campaign: (CampaignPayload & { key: string }) | null;
  items: Item[];
  attemptsByItem: Map<string, Attempt[]>;
  attempts: Attempt[];
  batches: Batch[];
  rules: Rule[];
  cells: Cell[];
  simulated: boolean;
  loaded: boolean;
}

function ofKind<K extends BoardRow['kind']>(rows: BoardRow[], kind: K): BoardRow<K>[] {
  return rows.filter((row): row is BoardRow<K> => row.kind === kind);
}

export function batchShare(batch: BatchPayload): number | null {
  if (typeof batch.accepted_share === 'number') return batch.accepted_share;
  const accepted = batch.accepted ?? 0;
  const decided = accepted + (batch.rejected ?? 0);
  if (batch.status === 'done' && batch.candidates) return accepted / batch.candidates;
  return decided > 0 ? accepted / decided : null;
}

// Unchanged rows keep their derived object, so memoized cards skip re-rendering.
const itemCache = new WeakMap<BoardRow, Item>();
const attemptCache = new WeakMap<BoardRow, Attempt>();

export function deriveView(rows: Map<string, BoardRow>, firstSeen: Map<string, number>, loadedAt: number): BoardView {
  const all = [...rows.values()];
  const campaigns = ofKind(all, 'campaign').sort((a, b) => b.id - a.id);
  const campaignRow = campaigns[0] ?? null;

  // Cards and batches written by the foreman name their campaign; show the current campaign's only.
  const currentKey = campaignRow?.key;
  const inCampaign = (payload: object) => {
    const campaign = (payload as { campaign?: unknown }).campaign;
    return typeof campaign !== 'string' || campaign === currentKey;
  };

  const items: Item[] = ofKind(all, 'item').filter((row) => inCampaign(row.payload)).map((row) => {
    const cached = itemCache.get(row);
    if (cached) return cached;
    const item: Item = {
      ...row.payload,
      key: row.key,
      rowId: row.id,
      updatedAt: row.created_at,
      firstSeen: firstSeen.get(`item:${row.key}`) ?? 0,
    };
    itemCache.set(row, item);
    return item;
  });

  const attempts: Attempt[] = ofKind(all, 'attempt')
    .map((row) => {
      const cached = attemptCache.get(row);
      if (cached) return cached;
      const attempt: Attempt = { ...row.payload, key: row.key, rowId: row.id, family: row.payload.family ?? modelFamily(row.payload.model) };
      attemptCache.set(row, attempt);
      return attempt;
    })
    .sort((a, b) => (b.at ?? b.rowId) - (a.at ?? a.rowId) || b.rowId - a.rowId);
  const attemptsByItem = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const list = attemptsByItem.get(attempt.item);
    if (list) list.push(attempt);
    else attemptsByItem.set(attempt.item, [attempt]);
  }

  const batches: Batch[] = ofKind(all, 'batch')
    .filter((row) => inCampaign(row.payload))
    .map((row) => {
      const share = batchShare(row.payload);
      const accepted = row.payload.accepted ?? 0;
      const learn = (row.payload as { learning?: BatchLearning }).learning;
      return {
        ...row.payload,
        share,
        usdPerAccepted: accepted > 0 && typeof row.payload.cost_usd === 'number' ? row.payload.cost_usd / accepted : null,
        learn: learn && typeof learn.decided === 'number' ? learn : null,
      };
    })
    .sort((a, b) => a.n - b.n);

  const rules: Rule[] = ofKind(all, 'rule')
    .filter((row) => inCampaign(row.payload))
    .map((row) => ({ ...row.payload, key: row.key }))
    .sort((a, b) => b.batch_introduced - a.batch_introduced || a.key.localeCompare(b.key));

  const cells: Cell[] = ofKind(all, 'cell')
    .map((row) => ({ ...row.payload, key: row.key, family: row.payload.family ?? modelFamily(row.payload.model) }))
    .sort((a, b) => b.pass_at_1 - a.pass_at_1 || (a.usd_per_solve ?? Infinity) - (b.usd_per_solve ?? Infinity));

  const simulated = all.some((row) => (row.payload as { simulated?: boolean }).simulated === true);

  return {
    campaign: campaignRow ? { ...campaignRow.payload, key: campaignRow.key } : null,
    items,
    attempts,
    attemptsByItem,
    batches,
    rules,
    cells,
    simulated,
    loaded: loadedAt > 0,
  };
}

export function useBoardView(): BoardView {
  const rows = useBoard((state) => state.rows);
  const firstSeen = useBoard((state) => state.firstSeen);
  const loadedAt = useBoard((state) => state.loadedAt);
  return useMemo(() => deriveView(rows, firstSeen, loadedAt), [rows, firstSeen, loadedAt]);
}
