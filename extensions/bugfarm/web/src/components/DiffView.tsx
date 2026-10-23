import { useMemo } from 'react';
import { highlight, parseDiff, type DiffLine } from '../lib/highlight';

function Code({ text, language }: { text: string; language: 'python' | 'ts' | 'plain' }) {
  const tokens = useMemo(() => highlight(text, language), [text, language]);
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className={token.kind === 'plain' ? undefined : `syn-${token.kind}`}>{token.text}</span>
      ))}
    </>
  );
}

const ROW: Record<DiffLine['type'], string> = {
  add: 'bg-[rgb(var(--diff-add)/0.13)]',
  del: 'bg-[rgb(var(--diff-del)/0.13)]',
  ctx: '',
  hunk: 'bg-well text-ink-3',
  note: 'text-ink-3',
};

const SIGN: Record<DiffLine['type'], string> = { add: '+', del: '−', ctx: ' ', hunk: '', note: '' };

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (files.length === 0) return <p className="text-ink-3">No diff was recorded for this candidate.</p>;
  return (
    <div className="space-y-3">
      {files.map((file) => (
        <figure key={file.path} className="overflow-hidden rounded-card border border-line bg-card">
          <figcaption className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
            <span className="min-w-0 truncate font-mono text-[0.82rem] font-semibold">{file.path}</span>
            <span className="shrink-0 font-mono text-[0.78rem] tnum">
              <span className="text-sprout">+{file.additions}</span> <span className="text-ember">−{file.deletions}</span>
            </span>
          </figcaption>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full border-collapse font-mono text-[0.8rem] leading-[1.6]">
              <tbody>
                {file.lines.map((line, index) => (
                  <tr key={index} className={ROW[line.type]}>
                    {line.type === 'hunk' ? (
                      <td colSpan={4} className="px-3 py-0.5 text-[0.75rem]">{line.text}</td>
                    ) : (
                      <>
                        <td className="w-[1%] select-none whitespace-nowrap px-2 text-right text-ink-3/70 tnum">{line.oldNo ?? ''}</td>
                        <td className="w-[1%] select-none whitespace-nowrap px-2 text-right text-ink-3/70 tnum">{line.newNo ?? ''}</td>
                        <td className={`w-[1%] select-none pl-1 pr-2 ${line.type === 'add' ? 'text-sprout' : line.type === 'del' ? 'text-ember' : 'text-ink-3'}`}>{SIGN[line.type]}</td>
                        <td className="whitespace-pre pr-4 text-ink"><Code text={line.text} language={file.language} /></td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      ))}
    </div>
  );
}
