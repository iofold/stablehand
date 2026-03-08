import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, AlertTriangle, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message } from '@/stores/conversation';
import { FeedbackButtons } from './FeedbackButtons';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  agentId?: string;
  conversationId?: string;
}

export function MessageBubble({ message, isStreaming, agentId, conversationId }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool';

  /* ── User message ── */
  if (isUser) {
    return (
      <div data-testid="message-bubble-user" className="flex items-start justify-end gap-3 py-3 animate-fade-in">
        <div className="max-w-[75%] min-w-0">
          <div className="rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-sm text-white leading-relaxed shadow-sm shadow-brand-700/30">
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        </div>
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-brand-600/20 ring-1 ring-brand-500/30">
          <User className="h-3.5 w-3.5 text-brand-400" />
        </div>
      </div>
    );
  }

  /* ── System / error message ── */
  if (isSystem) {
    return (
      <div className="flex items-start gap-3 py-3 animate-fade-in">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-red-900/30 ring-1 ring-red-800/40">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="rounded-xl rounded-bl-md border border-red-800/30 bg-red-950/30 px-4 py-2.5 text-sm text-red-300 leading-relaxed">
            <p className="break-words">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  /* ── Assistant message ── */
  // Strip A2UI JSON payloads from content (they render as separate components)
  const cleanContent = message.a2uiBlocks?.length
    ? message.content.replace(/\{\s*"component"\s*:\s*"[^"]+"\s*,\s*"props"\s*:\s*\{[\s\S]*?\}\s*\}/g, '').trim()
    : message.content;

  // Don't render empty assistant messages (only had A2UI payloads)
  const hasTextContent = cleanContent.length > 0;

  return (
    <div
      data-testid="message-bubble-assistant"
      className="flex items-start gap-3 py-3 animate-fade-in"
    >
      {hasTextContent && (
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-surface-800 ring-1 ring-surface-700/50">
        <Sparkles className="h-3.5 w-3.5 text-brand-400" />
      </div>
      )}
      {hasTextContent && (
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            'prose prose-invert prose-sm max-w-none text-sm leading-relaxed text-surface-200',
            /* Headings */
            '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-surface-100 [&_h1]:mt-4 [&_h1]:mb-2',
            '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-surface-100 [&_h2]:mt-3 [&_h2]:mb-1.5',
            '[&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-surface-200 [&_h3]:mt-2 [&_h3]:mb-1',
            /* Code blocks */
            '[&_pre]:bg-surface-900/80 [&_pre]:border [&_pre]:border-surface-700/40 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto',
            '[&_pre_code]:text-[13px] [&_pre_code]:leading-relaxed [&_pre_code]:text-surface-300',
            /* Inline code */
            '[&_:not(pre)>code]:text-brand-300 [&_:not(pre)>code]:bg-brand-600/10 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:text-[13px] [&_:not(pre)>code]:font-mono',
            /* Links */
            '[&_a]:text-brand-400 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-brand-400/30 hover:[&_a]:decoration-brand-400',
            /* Lists */
            '[&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_li]:text-surface-300',
            /* Tables */
            '[&_table]:border-collapse [&_table]:my-2 [&_th]:border [&_th]:border-surface-700/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:bg-surface-800/50 [&_th]:text-surface-300 [&_th]:text-xs [&_th]:font-medium',
            '[&_td]:border [&_td]:border-surface-700/50 [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-surface-400 [&_td]:text-xs',
            /* Blockquotes */
            '[&_blockquote]:border-l-2 [&_blockquote]:border-brand-500/40 [&_blockquote]:pl-3 [&_blockquote]:text-surface-400 [&_blockquote]:italic [&_blockquote]:my-2',
            /* Paragraphs */
            '[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
            /* Strong/emphasis */
            '[&_strong]:text-surface-100 [&_strong]:font-semibold',
            '[&_em]:text-surface-300',
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {cleanContent}
          </ReactMarkdown>
          {isStreaming && (
            <span className="typing-cursor" />
          )}
        </div>
        {!isStreaming && agentId && (
          <FeedbackButtons
            agentId={agentId}
            messageId={message.id}
            conversationId={conversationId}
          />
        )}
      </div>
      )}
    </div>
  );
}
