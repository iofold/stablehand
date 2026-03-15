import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'send-notification',
  description: 'Send a notification alert about an urgent email. Simulates delivery via Slack, SMS, or push notification.',
  input: z.object({
    channel: z.enum(['slack', 'sms', 'push']).default('slack').describe('Notification channel'),
    recipient: z.string().describe('Who to notify (e.g., user handle or phone number)'),
    title: z.string().describe('Notification title'),
    body: z.string().describe('Notification body text'),
    urgency: z.enum(['critical', 'high', 'medium']).default('high').describe('Notification urgency level'),
  }),
  handler: async (input, _ctx) => {
    // Simulated notification delivery
    const notification = {
      notificationId: 'NTF-' + Date.now(),
      channel: input.channel,
      recipient: input.recipient,
      title: input.title,
      body: input.body,
      urgency: input.urgency,
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
    };

    return JSON.stringify({
      ...notification,
      message: `Notification sent via ${input.channel} to ${input.recipient} [${input.urgency}]`,
    });
  },
});
