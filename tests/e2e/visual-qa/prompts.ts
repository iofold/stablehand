/**
 * Event-type-specific analysis prompts for visual QA.
 * Used with look_at tool for Gemini-based screenshot analysis.
 *
 * Each prompt describes what a correctly-rendered screenshot should look like
 * for a specific AG-UI event state.
 */
export const EVENT_PROMPTS: Record<string, string> = {
  'empty-state':
    'Analyze this chat UI screenshot showing the empty/initial state. Check: ' +
    'Is there a welcome message or hero section? Is the chat input visible at the bottom? ' +
    'Is a send button visible (should be disabled with empty input)? ' +
    'Is the layout clean with no broken elements? Are there any suggested prompts?',

  'user-message':
    'Analyze this chat UI showing a user message. Check: ' +
    'Is there a message bubble on the right side (user messages are right-aligned)? ' +
    'Does it contain the text the user typed? Is it styled differently from assistant messages?',

  'text-streaming':
    'Analyze this chat UI during active text streaming from the AI assistant. Check: ' +
    'Is there an assistant message bubble appearing on the left side? ' +
    'Is text visible and appearing to stream in? Is there a typing/streaming indicator? ' +
    'Is markdown rendering correctly (bold, italic, lists)? ' +
    'Is there a "Live" indicator or similar streaming badge?',

  'text-complete':
    'Analyze this chat UI showing a completed assistant message. Check: ' +
    'Is the full message visible with no truncation? Is markdown rendered (bold, italic, code blocks, lists)? ' +
    'Is there NO streaming/typing indicator? Are feedback buttons (thumbs up/down) visible? ' +
    'Is the chat input ready for the next message?',

  'tool-call-running':
    'Analyze this chat UI showing an active/running tool call. Check: ' +
    'Is there a tool call card visible? Does it show the tool name? ' +
    'Is there a yellow or pulsing status indicator showing the tool is running? ' +
    'Are tool arguments displayed (possibly in a collapsible section)?',

  'tool-call-complete':
    'Analyze this chat UI showing a completed tool call. Check: ' +
    'Is the tool call card visible? Does it show the tool name? ' +
    'Is there a green completion indicator (checkmark or green dot)? ' +
    'Is the tool result displayed? Are both arguments and result available?',

  'hitl-pending':
    'Analyze this chat UI showing a pending HITL (Human-in-the-Loop) approval request. Check: ' +
    'Is there an approval card distinct from regular messages? ' +
    'Are "Approve" and "Reject" buttons clearly visible? ' +
    'Does it show details about what action needs approval? ' +
    'Is the card styled with an attention-grabbing appearance (border, background)?',

  'hitl-resolved':
    'Analyze this chat UI showing a resolved HITL approval. Check: ' +
    'Is there a status badge showing "approved" (green) or "rejected" (red)? ' +
    'Are the action buttons now disabled or hidden? ' +
    'Is the resolution status clearly indicated?',

  'a2ui-chart':
    'Analyze this UI screenshot showing an A2UI chart/visualization block. Check: ' +
    'Is there a chart or visualization rendered (SVG, canvas, or div-based)? ' +
    'Is it a recognizable chart type (bar, line, pie, etc.)? ' +
    'Are axes labeled (if applicable)? Is data displayed? ' +
    'Is there any error fallback or "unknown component" message instead of the chart?',

  'run-finished':
    'Analyze this chat UI after a completed agent run. Check: ' +
    'Is the full conversation visible with all messages and tool calls? ' +
    'Is there NO streaming indicator or loading state? ' +
    'Are all tool call cards in completed state (green indicators)? ' +
    'Are feedback buttons visible? Is the chat input ready for next message?',

  'error-state':
    'Analyze this chat UI showing an error state. Check: ' +
    'Is there an error message component with an alert/warning icon? ' +
    'Is a status code or error type badge visible? ' +
    'Is there an error summary message? Are retry and dismiss buttons available? ' +
    'Is there an expandable section for technical details?',

  'replay-mode':
    'Analyze this run detail/replay page showing a completed agent run. Check: ' +
    'Is the page showing static content (no streaming indicators, no typing animation)? ' +
    'Are all messages fully rendered? Are all tool call cards in completed state? ' +
    'Is there a back button or navigation to return to the agent page? ' +
    'Is the status badge showing "completed" or similar? ' +
    'Is there NO chat input (replay is read-only)?',

  'replay-tool-calls':
    'Analyze tool call cards in this replay/run detail view. Check: ' +
    'Are all tool calls shown in their final completed state? ' +
    'Do they have green status indicators? Are results visible? ' +
    'Are there no "running" or "pending" indicators?',
};
