/**
 * Checkpoint serialization for session suspend/resume.
 *
 * v2 format: structured envelope + opaque harness state blob.
 *
 * Security: Checkpoints MUST NOT contain resolved secret values (API keys,
 * tokens). Secrets are injected fresh on resume via tmpfs mount.
 */

import type { AgentEvent, HarnessExportedState } from '../harness/types.js';
import { stringifyJsonWithBigInts } from './json-serialization.js';

/* -------------------------------------------------------------------------- */
/*  Checkpoint types                                                           */
/* -------------------------------------------------------------------------- */

export interface WorkspaceRef {
  strategy: 'tar' | 'git' | 'none';
  reference: string;
}

export interface PendingRequest {
  type: 'tool_call' | 'approval';
  id: string;
  payload: Record<string, unknown>;
}

export interface SessionCheckpoint {
  checkpointVersion: 2;
  sessionId: string;
  conversationId: string;
  harnessName: string;
  cursor: {
    nextMessageSeq: number;
    lastCompletedTurnId?: string;
  };
  runnerState: {
    status: 'IDLE' | 'WAITING_INPUT';
    pendingRequests?: PendingRequest[];
  };
  workspaceRef: WorkspaceRef;
  harnessState: HarnessExportedState;
}

/* -------------------------------------------------------------------------- */
/*  Size limits                                                                */
/* -------------------------------------------------------------------------- */

const SIZE_WARN_BYTES = 1 * 1024 * 1024;
const SIZE_REJECT_BYTES = 5 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*  SessionStateCollector                                                      */
/* -------------------------------------------------------------------------- */

export class SessionStateCollector {
  private messageSeq = 0;
  private currentTurnId?: string;
  private pendingRequests: PendingRequest[] = [];

  startTurn(turnId: string): void {
    this.currentTurnId = turnId;
  }

  processTurnEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'tool_call_start':
        this.pendingRequests.push({
          type: 'tool_call',
          id: event.id,
          payload: {
            name: event.name,
            args: event.args as Record<string, unknown>,
          },
        });
        break;

      case 'tool_call_end':
        this.pendingRequests = this.pendingRequests.filter((r) => r.id !== event.id);
        break;

      case 'approval_needed':
        this.pendingRequests.push({
          type: 'approval',
          id: event.id,
          payload: {
            tool: event.tool,
            args: event.args as Record<string, unknown>,
          },
        });
        break;

      case 'approval_resolved':
        this.pendingRequests = this.pendingRequests.filter((r) => r.id !== event.id);
        break;

      case 'message_committed':
        this.messageSeq = event.messageSeq + 1;
        break;
    }
  }

  endTurn(): void {
    this.currentTurnId = undefined;
  }

  getCheckpointSnapshot(
    sessionId: string,
    conversationId: string,
    harnessName: string,
    harnessState: HarnessExportedState,
    workspaceRef: WorkspaceRef,
  ): SessionCheckpoint {
    const hasPending = this.pendingRequests.length > 0;
    return {
      checkpointVersion: 2,
      sessionId,
      conversationId,
      harnessName,
      cursor: {
        nextMessageSeq: this.messageSeq,
        lastCompletedTurnId: this.currentTurnId,
      },
      runnerState: {
        status: hasPending ? 'WAITING_INPUT' : 'IDLE',
        pendingRequests: hasPending ? [...this.pendingRequests] : undefined,
      },
      workspaceRef,
      harnessState,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Serialization / Deserialization                                            */
/* -------------------------------------------------------------------------- */

export function serializeCheckpoint(state: SessionCheckpoint): string {
  return stringifyJsonWithBigInts(state);
}

export function deserializeCheckpoint(json: string): SessionCheckpoint {
  const parsed = JSON.parse(json) as SessionCheckpoint;

  if (parsed.checkpointVersion !== 2) {
    throw new Error(
      `Unsupported checkpoint version: ${parsed.checkpointVersion}. Expected: 2`,
    );
  }

  return parsed;
}

/* -------------------------------------------------------------------------- */
/*  Size validation                                                            */
/* -------------------------------------------------------------------------- */

export interface CheckpointSizeResult {
  ok: boolean;
  sizeBytes: number;
  warning?: string;
  error?: string;
}

export function validateCheckpointSize(json: string, maxBytes?: number): CheckpointSizeResult {
  const sizeBytes = Buffer.byteLength(json, 'utf-8');
  const rejectThreshold = maxBytes ?? SIZE_REJECT_BYTES;
  const warnThreshold = Math.min(SIZE_WARN_BYTES, Math.floor(rejectThreshold * 0.2));

  if (sizeBytes > rejectThreshold) {
    const limitMb = (rejectThreshold / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      sizeBytes,
      error: `Checkpoint size ${sizeBytes} bytes exceeds maximum of ${rejectThreshold} bytes (${limitMb} MB)`,
    };
  }

  if (sizeBytes > warnThreshold) {
    return {
      ok: true,
      sizeBytes,
      warning: `Checkpoint size ${sizeBytes} bytes exceeds warning threshold of ${warnThreshold} bytes`,
    };
  }

  return { ok: true, sizeBytes };
}
