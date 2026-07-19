import { z } from 'zod';

const id = <T extends string>(_brand: T) => z.string().trim().min(1).brand<T>();

export const AgentIdSchema = id('AgentId');
export const ConversationIdSchema = id('ConversationId');
export const TurnIdSchema = id('TurnId');
export const SandboxSessionIdSchema = id('SandboxSessionId');
export const InterruptIdSchema = id('InterruptId');
export const ToolCallIdSchema = id('ToolCallId');
export const MessageIdSchema = id('MessageId');
export const WebhookIdSchema = id('WebhookId');
export const WebhookDeliveryIdSchema = id('WebhookDeliveryId');

export type AgentId = z.infer<typeof AgentIdSchema>;
export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type TurnId = z.infer<typeof TurnIdSchema>;
export type SandboxSessionId = z.infer<typeof SandboxSessionIdSchema>;
export type InterruptId = z.infer<typeof InterruptIdSchema>;
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type WebhookId = z.infer<typeof WebhookIdSchema>;
export type WebhookDeliveryId = z.infer<typeof WebhookDeliveryIdSchema>;
