import type { EventMap, EventName } from '../../events/bus.js';
import type { AGUIProtocolEvent } from './types.js';

export class AGUIEventNormalizer {
  private textMessageInProgress = false;
  private currentMessageId = '';
  private messageCounter = 0;
  private readonly runId: string;
  private readonly threadId: string;

  constructor(runId: string, threadId: string) {
    this.runId = runId;
    this.threadId = threadId;
  }

  normalize(eventName: EventName, payload: EventMap[EventName]): AGUIProtocolEvent[] {
    switch (eventName) {
      case 'turn.started': {
        const turnStarted = payload as EventMap['turn.started'];
        return [{
          type: 'RUN_STARTED',
          runId: this.runId,
          threadId: this.threadId,
          timestamp: turnStarted.timestamp,
        }];
      }

      case 'run.text_chunk': {
        const textChunk = payload as EventMap['run.text_chunk'];
        const events: AGUIProtocolEvent[] = [];
        if (!this.textMessageInProgress) {
          this.messageCounter += 1;
          this.currentMessageId = `msg-${this.messageCounter}`;
          this.textMessageInProgress = true;
          events.push({
            type: 'TEXT_MESSAGE_START',
            runId: this.runId,
            threadId: this.threadId,
            messageId: this.currentMessageId,
            role: 'assistant',
            timestamp: textChunk.timestamp,
          });
        }

        events.push({
          type: 'TEXT_MESSAGE_CONTENT',
          runId: this.runId,
          threadId: this.threadId,
          messageId: this.currentMessageId,
          delta: textChunk.content,
          timestamp: textChunk.timestamp,
        });

        return events;
      }

      case 'run.tool_started': {
        const toolStarted = payload as EventMap['run.tool_started'];
        const closeEvent = this.closeTextMessage(toolStarted.timestamp);
        const events: AGUIProtocolEvent[] = closeEvent ? [closeEvent] : [];
        events.push(
          {
            type: 'TOOL_CALL_START',
            runId: this.runId,
            threadId: this.threadId,
            toolCallId: toolStarted.toolCallId,
            toolCallName: toolStarted.toolName,
            timestamp: toolStarted.timestamp,
          },
          {
            type: 'TOOL_CALL_ARGS',
            runId: this.runId,
            threadId: this.threadId,
            toolCallId: toolStarted.toolCallId,
            delta: JSON.stringify(toolStarted.args),
            timestamp: toolStarted.timestamp,
          },
        );
        return events;
      }

      case 'run.tool_result': {
        const toolResult = payload as EventMap['run.tool_result'];
        return [{
          type: 'TOOL_CALL_END',
          runId: this.runId,
          threadId: this.threadId,
          toolCallId: toolResult.toolCallId,
          toolCallName: toolResult.toolName,
          result: toolResult.error ?? toolResult.result,
          timestamp: toolResult.timestamp,
        }];
      }

      case 'turn.completed': {
        const turnCompleted = payload as EventMap['turn.completed'];
        const events: AGUIProtocolEvent[] = [];
        const closeEvent = this.closeTextMessage(turnCompleted.timestamp);
        if (closeEvent) {
          events.push(closeEvent);
        }
        if (turnCompleted.status === 'error' || turnCompleted.status === 'cancelled') {
          events.push({
            type: 'RUN_ERROR',
            runId: this.runId,
            threadId: this.threadId,
            error: turnCompleted.error ?? (turnCompleted.status === 'cancelled' ? 'Run cancelled' : 'Run failed'),
            status: turnCompleted.status,
            timestamp: turnCompleted.timestamp,
          });
        }
        events.push({
          type: 'RUN_FINISHED',
          runId: this.runId,
          threadId: this.threadId,
          status: turnCompleted.status,
          timestamp: turnCompleted.timestamp,
        });
        return events;
      }

      case 'run.ag_ui_event': {
        const agUiEvent = payload as EventMap['run.ag_ui_event'];
        return [agUiEvent.event as AGUIProtocolEvent];
      }

      case 'run.interrupted': {
        const interrupted = payload as EventMap['run.interrupted'];
        return [{
          type: 'CUSTOM',
          runId: this.runId,
          threadId: this.threadId,
          subtype: 'hitl_pause',
          toolCallId: interrupted.toolCallId,
          toolName: interrupted.toolName,
          args: interrupted.args,
          interruptId: interrupted.interruptId,
          timestamp: interrupted.timestamp,
        }];
      }

      case 'run.interrupt_resolved': {
        const interruptResolved = payload as EventMap['run.interrupt_resolved'];
        return [{
          type: 'CUSTOM',
          runId: this.runId,
          threadId: this.threadId,
          subtype: 'hitl_resolved',
          interruptId: interruptResolved.interruptId,
          action: interruptResolved.action,
          timestamp: interruptResolved.timestamp,
        }];
      }

      default:
        return [];
    }
  }

  private closeTextMessage(timestamp: number): AGUIProtocolEvent | null {
    if (!this.textMessageInProgress) {
      return null;
    }

    const event: AGUIProtocolEvent = {
      type: 'TEXT_MESSAGE_END',
      runId: this.runId,
      threadId: this.threadId,
      messageId: this.currentMessageId,
      timestamp,
    };

    this.textMessageInProgress = false;
    this.currentMessageId = '';
    return event;
  }
}
