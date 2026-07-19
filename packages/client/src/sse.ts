export interface ServerSentEvent {
  id: string | null;
  eventName: string | null;
  data: string | null;
  retry: number | null;
  comment: string | null;
}

function parseBlock(block: string, inheritedId: string | null): ServerSentEvent | null {
  const data: string[] = [];
  const comments: string[] = [];
  let id = inheritedId;
  let eventName: string | null = null;
  let retry: number | null = null;
  let sawField = false;

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) {
      comments.push(line.slice(1).replace(/^ /, ''));
      sawField = true;
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    switch (field) {
      case 'data':
        data.push(value);
        sawField = true;
        break;
      case 'event':
        eventName = value;
        sawField = true;
        break;
      case 'id':
        if (!value.includes('\0')) {
          id = value;
        }
        sawField = true;
        break;
      case 'retry': {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 0) {
          retry = parsed;
        }
        sawField = true;
        break;
      }
    }
  }

  if (!sawField) return null;
  return {
    id,
    eventName,
    data: data.length > 0 ? data.join('\n') : null,
    retry,
    comment: comments.length > 0 ? comments.join('\n') : null,
  };
}

export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEventId: string | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match = /\r?\n\r?\n/.exec(buffer);
      while (match?.index !== undefined) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseBlock(block, lastEventId);
        if (parsed) {
          lastEventId = parsed.id;
          yield parsed;
        }
        match = /\r?\n\r?\n/.exec(buffer);
      }
    }

    buffer += decoder.decode();
    const parsed = parseBlock(buffer.replace(/\r?\n$/, ''), lastEventId);
    if (parsed) {
      yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}
