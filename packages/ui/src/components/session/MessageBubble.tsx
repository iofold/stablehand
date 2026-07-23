import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '@/lib/utils';
import type { Message } from '@/stores/conversation';
import { FeedbackButtons } from './FeedbackButtons';
import { ErrorDisplay } from './ErrorDisplay';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  agentId?: string;
  conversationId?: string;
}

export function MessageBubble({ message, isStreaming, agentId, conversationId }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  /* ── User message ── */
  if (isUser) {
    return (
      <div data-testid="message-bubble-user" className="flex justify-end py-3 animate-fade-in">
        <div className="max-w-[75%] min-w-0 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-surface-200">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  /* ── System / error message ── */
  if (isSystem) {
    // Detect error messages (from RUN_ERROR SSE events, prefixed with "Error: ")
    const isError = message.content.startsWith('Error: ');
    if (isError) {
      const rawError = message.content.slice('Error: '.length);
      // Try to extract a status code from JSON-like content
      let statusCode: number | undefined;
      let details: string | undefined;
      let summary = rawError;
      try {
        const parsed = JSON.parse(rawError);
        if (typeof parsed === 'object' && parsed !== null) {
          statusCode = typeof parsed.statusCode === 'number' ? parsed.statusCode : (typeof parsed.status === 'number' ? parsed.status : undefined);
          summary = parsed.message || parsed.error || parsed.detail || 'An error occurred';
          if (parsed.stack || parsed.detail || rawError.length > 120) {
            details = rawError;
          }
        }
      } catch {
        // Not JSON — check for common HTTP status patterns like "404: ..." or "(404)"
        const statusMatch = rawError.match(/^(\d{3})\b[:\s]*/);
        if (statusMatch) {
          statusCode = parseInt(statusMatch[1], 10);
          summary = rawError.slice(statusMatch[0].length) || rawError;
        }
        // If the raw error is very long (likely a blob), put it in details
        if (rawError.length > 120) {
          details = rawError;
          summary = 'An error occurred';
        }
      }
      return (
        <div className="py-2 max-w-[85%] animate-fade-in">
          <ErrorDisplay
            summary={summary}
            statusCode={statusCode}
            details={details}
          />
        </div>
      );
    }

    return (
      <div className="flex justify-center py-2 animate-fade-in">
        <div className="text-surface-400 text-sm italic text-center max-w-[85%] break-words">
          {message.content}
        </div>
      </div>
    );
  }

  /* ── Assistant message ── */
  const cleanContent = message.content;

  const hasTextContent = cleanContent.length > 0;

  if (!hasTextContent) return null;

  return (
    <div
      data-testid="message-bubble-assistant"
      className="flex flex-col gap-1 py-3 animate-fade-in"
    >
      <div className="min-w-0 max-w-[85%] border-l-2 border-surface-700 pl-4 py-2">
        <div
          className={cn(
            'prose prose-invert prose-sm max-w-none text-sm leading-relaxed text-surface-300',
            /* Headings */
            '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-surface-100 [&_h1]:mt-4 [&_h1]:mb-2',
            '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-surface-100 [&_h2]:mt-3 [&_h2]:mb-1.5',
            '[&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-surface-200 [&_h3]:mt-2 [&_h3]:mb-1',
            /* Code blocks */
            '[&_pre]:bg-surface-950 [&_pre]:border [&_pre]:border-surface-700 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:font-mono [&_pre]:text-sm',
            '[&_pre_code]:text-[13px] [&_pre_code]:leading-relaxed [&_pre_code]:text-surface-300',
            /* Inline code */
            '[&_:not(pre)>code]:text-accent-300 [&_:not(pre)>code]:bg-accent-600/10 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:text-[13px] [&_:not(pre)>code]:font-mono',
            /* Links */
            '[&_a]:text-accent-400 [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-accent-400/30 hover:[&_a]:decoration-accent-400',
            /* Lists */
            '[&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_li]:text-surface-300',
            /* Tables */
            '[&_table]:border-collapse [&_table]:my-2 [&_th]:border [&_th]:border-surface-700/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:bg-surface-800/50 [&_th]:text-surface-300 [&_th]:text-xs [&_th]:font-medium',
            '[&_td]:border [&_td]:border-surface-700/50 [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-surface-400 [&_td]:text-xs',
            /* Blockquotes */
            '[&_blockquote]:border-l-2 [&_blockquote]:border-accent-500/40 [&_blockquote]:pl-3 [&_blockquote]:text-surface-400 [&_blockquote]:italic [&_blockquote]:my-2',
            /* Paragraphs */
            '[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
            /* Strong/emphasis */
            '[&_strong]:text-surface-100 [&_strong]:font-semibold',
            '[&_em]:text-surface-300',
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {cleanContent}
          </ReactMarkdown>
          {isStreaming && (
            <span className="typing-cursor" />
          )}
        </div>
        {!isStreaming && agentId && conversationId && (
          <div className="mt-2">
            <FeedbackButtons
              agentId={agentId}
              messageId={message.id}
              conversationId={conversationId}
            />
          </div>
        )}
      </div>
    </div>
  );
}
