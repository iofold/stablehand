import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifestProject } from '@stablehand/manifest/node';
import { afterAll, describe, expect, it } from 'vitest';

import { interpolateTemplate } from '../../../stablehand/src/events/triggers.js';
import { REVIEW_KEY, TASK_TEMPLATES } from '../seed.ts';

interface Location { location: string; text: string }
interface CorpusDocument { document: string; type: string; locations: Location[] }
interface Corpus {
  documents: CorpusDocument[];
  skipped?: Array<{ document: string; reason: string }>;
  changes?: Array<{ document: string; location: string; clause: string; text: string }>;
}
interface Row { severity: string; finding: string; document: string; location: string; quote: string; policy: string }
interface CheckReport { ok: boolean; rows: Row[]; issues: Array<{ index: number | null; problem: string }>; counts: Record<string, number>; documentsWithoutFindings: string[] }
interface Checker {
  checkFindings: (corpus: Corpus, findings: unknown) => CheckReport;
  summarize: (rows: Row[]) => string;
  renderReport: (corpus: Corpus, report: CheckReport, date?: string) => string;
  findingsTable: (rows: Row[]) => { title: string; columns: Array<{ key: string }>; data: Array<Record<string, string>> };
}

const FOLDER = fileURLToPath(new URL('../agent/folder/', import.meta.url));
const READER = fileURLToPath(new URL('../agent/tools/read_folder.py', import.meta.url));
const scratch: string[] = [];

async function checker(): Promise<Checker> {
  return await import('../agent/tools/check_findings.mjs') as Checker;
}

function canRun(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

const HAS_PYTHON = canRun('python3', ['--version']);
const HAS_PDF_READER = HAS_PYTHON && (
  canRun('python3', ['-c', 'import pdfplumber'])
  || canRun('python3', ['-c', 'import pypdf'])
  || canRun('pdftotext', ['-v'])
);

async function readFolder(folder: string): Promise<{ corpus: Corpus; corpusText: string; stdout: string }> {
  const out = await mkdtemp(join(tmpdir(), 'folder-review-'));
  scratch.push(out);
  const result = spawnSync('python3', [READER, folder, out], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`read_folder.py failed: ${result.stderr}`);
  return {
    corpus: JSON.parse(await readFile(join(out, 'corpus.json'), 'utf8')) as Corpus,
    corpusText: await readFile(join(out, 'corpus.txt'), 'utf8'),
    stdout: result.stdout,
  };
}

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A small corpus in read_folder.py's shape, so the checker tests need no Python. */
const CORPUS: Corpus = {
  documents: [
    {
      document: 'msa.pdf',
      type: 'pdf',
      locations: [
        { location: 'page 1', text: '3. Term and renewal\n3.1 This Agreement runs for 24 months.' },
        {
          location: 'page 2',
          text: '10. Liability\n10.1 Each party’s total liability is limited to the Fees paid\nin the 3 months before the claim.\n'
            + '12. Termination\n12.2 Courier may terminate this Agreement for convenience on 30 days’ written notice.',
        },
      ],
    },
    {
      document: 'amendment.pdf',
      type: 'pdf',
      locations: [{ location: 'page 1', text: '1. Liability\nClause 10.1 is replaced by: "limited to the Fees paid in the 12 months before the claim."' }],
    },
    {
      document: 'policy.md',
      type: 'markdown',
      locations: [
        { location: '§ Vendor policy', text: '# Vendor policy' },
        { location: '§ 2. Data protection', text: '## 2. Data protection\n\n2.2 Breach notice within 72 hours.' },
        { location: '§ 3. Term, renewal and notice', text: '## 3. Term, renewal and notice\n\n3.3 At least 90 days\' notice.' },
      ],
    },
  ],
  skipped: [{ document: 'logo.png', reason: 'unsupported file type' }],
  changes: [{ document: 'amendment.pdf', location: 'page 1', clause: '10.1', text: 'Clause 10.1 is replaced by: "limited to the Fees paid in the 12 months before the claim."' }],
};

describe('folder review manifest and folder', () => {
  it('compiles into a capped agent with the folder and its tools in the workspace', async () => {
    const project = await loadManifestProject(fileURLToPath(new URL('../agent/agent.yaml', import.meta.url)));
    const input = project.agentCreateInput;
    expect(input.name).toBe('folder-review');
    expect(input.mode).toBe('both');
    expect(input.tools).toEqual(['artifact_upload']);
    expect(input.metadata).toMatchObject({ defaultTags: { campaign: 'folder-review' } });
    expect((input.harnessConfig as { limits?: { maxCostUsd?: number } }).limits?.maxCostUsd).toBe(0.75);
    const files = project.workspace.files.map((file) => file.destinationPath).sort();
    expect(files.filter((file) => file.startsWith('tools/'))).toEqual(['tools/check_findings.mjs', 'tools/read_folder.py']);
    expect(files.filter((file) => file.startsWith('folder/'))).toHaveLength(10);
  });

  it('ships ten invented documents, five of them PDFs built from typst sources', async () => {
    const names = (await readdir(FOLDER)).sort();
    expect(names.filter((name) => name.endsWith('.pdf'))).toHaveLength(5);
    expect(names.filter((name) => name.endsWith('.md'))).toHaveLength(5);
    for (const name of names.filter((entry) => entry.endsWith('.md'))) {
      expect(await readFile(join(FOLDER, name), 'utf8'), name).toContain('Synthetic sample for the Stablehand folder review demo');
    }
    const sources = await readdir(fileURLToPath(new URL('../documents-src/', import.meta.url)));
    for (const pdf of names.filter((name) => name.endsWith('.pdf'))) {
      expect(sources, pdf).toContain(pdf.replace(/\.pdf$/, '.typ'));
    }
    const template = await readFile(fileURLToPath(new URL('../documents-src/template.typ', import.meta.url)), 'utf8');
    expect(template).toContain('Every party in it is invented.');
  });

  it('renders tasks that carry the review id and today\'s date', () => {
    expect(REVIEW_KEY).toBe('{{payload.reviewId}}');
    expect(interpolateTemplate(TASK_TEMPLATES.start, { reviewId: 'binder', request: 'Check it.', today: '2026-10-23' }))
      .toBe('Review the folder. Review id: binder. Today is 2026-10-23.\n\nCheck it.');
    expect(interpolateTemplate(TASK_TEMPLATES.question, { reviewId: 'binder', question: 'What renews?', today: '2026-10-23' }))
      .toBe('Question about review binder (today is 2026-10-23): What renews?');
  });
});

describe('folder reader', () => {
  it.skipIf(!HAS_PDF_READER)('splits PDFs by page and markdown by section, and lists clauses later documents replace', async () => {
    const { corpus, corpusText, stdout } = await readFolder(FOLDER);
    expect(stdout).toContain('Read 10 documents');
    const pages = Object.fromEntries(corpus.documents.filter((doc) => doc.type === 'pdf').map((doc) => [doc.document, doc.locations.length]));
    expect(pages).toEqual({
      'ampelfield-supply-agreement.pdf': 3,
      'quaywise-amendment-1.pdf': 1,
      'quaywise-dpa.pdf': 2,
      'quaywise-insurance-certificate.pdf': 1,
      'quaywise-msa.pdf': 4,
    });
    const msa = corpus.documents.find((doc) => doc.document === 'quaywise-msa.pdf')!;
    expect(msa.locations[3]!.location).toBe('page 4');
    expect(msa.locations[3]!.text).toContain('for convenience on 30 days');
    const policy = corpus.documents.find((doc) => doc.document === 'vendor-policy.md')!;
    expect(policy.locations.map((entry) => entry.location)).toContain('§ 3. Term, renewal and notice');
    expect(corpus.changes?.map((change) => [change.document, change.location, change.clause])).toEqual([
      ['quaywise-amendment-1.pdf', 'page 1', '10.1'],
      ['quaywise-amendment-1.pdf', 'page 1', '2.2'],
    ]);
    expect(corpusText.startsWith('=== Changes between documents ===')).toBe(true);
    expect(corpusText).toContain('=== quaywise-msa.pdf | page 4 ===');
  });

  it.skipIf(!HAS_PYTHON)('reads text and markdown without a PDF library and skips what it cannot read', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'folder-review-src-'));
    scratch.push(folder);
    await writeFile(join(folder, 'notes.md'), 'Intro line.\n\n# Title\n\nBody.\n\n## 2. Prices\n\nUp 5%.\n');
    await writeFile(join(folder, 'memo.txt'), 'Plain memo.\n');
    await writeFile(join(folder, 'image.png'), 'not really an image');
    const { corpus, stdout } = await readFolder(folder);
    expect(corpus.documents.map((doc) => [doc.document, doc.locations.map((entry) => entry.location)])).toEqual([
      ['memo.txt', ['whole file']],
      ['notes.md', ['§ (top)', '§ Title', '§ 2. Prices']],
    ]);
    expect(corpus.skipped).toEqual([{ document: 'image.png', reason: 'unsupported file type' }]);
    expect(stdout).toContain('memo.txt (text, 1 section)');
  });
});

describe('citation checker', () => {
  it('accepts findings whose quotes sit on the cited page or in the cited section', async () => {
    const { checkFindings } = await checker();
    const report = checkFindings(CORPUS, [
      { severity: 'medium', document: 'msa.pdf', location: 'page 2', quote: "Courier may terminate this Agreement for convenience on 30 days' written notice", finding: 'Courier can leave on 30 days.', policy: 'policy.md 3.3' },
      { severity: 'HIGH', document: 'MSA.pdf', location: 'p. 1, clause 3.1', quote: 'runs for 24 months', finding: 'Two-year term.' },
      { severity: 'low', document: 'policy.md', location: '§ 2.2', quote: 'Breach notice within 72 hours', finding: 'The policy asks for 72 hours.' },
      { severity: 'low', document: 'amendment.pdf', location: 'page 1', quote: 'Clause 10.1 is replaced by', finding: 'The amendment raises the liability cap to 12 months.' },
    ]);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows.map((row) => [row.severity, row.document, row.location])).toEqual([
      ['high', 'msa.pdf', 'page 1'],
      ['medium', 'msa.pdf', 'page 2'],
      ['low', 'policy.md', '§ 2. Data protection'],
      ['low', 'amendment.pdf', 'page 1'],
    ]);
    expect(report.counts).toEqual({ high: 1, medium: 1, low: 2 });
  });

  it('says where a misplaced quote really is and refuses invented ones', async () => {
    const { checkFindings } = await checker();
    const report = checkFindings(CORPUS, [
      { severity: 'high', document: 'msa.pdf', location: 'page 1', quote: 'for convenience on 30 days', finding: 'x' },
      { severity: 'high', document: 'msa.pdf', location: 'page 2', quote: 'unlimited liability', finding: 'x' },
      { severity: 'high', document: 'nda.md', location: '§ 1', quote: 'x', finding: 'x' },
      { severity: 'high', document: 'msa.pdf', location: 'page 9', quote: 'x', finding: 'x' },
      { severity: 'urgent', document: 'msa.pdf', location: 'page 2', quote: 'x', finding: 'x' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.problem)).toEqual([
      'the quote is on page 2 of msa.pdf, not page 1',
      'the quote is not in msa.pdf; copy it word for word or drop it',
      'no document named nda.md in the folder',
      'msa.pdf has no page 9; its locations are page 1, page 2',
      'severity must be high, medium or low',
    ]);
  });

  it('refuses a finding on a clause a later document replaced, unless it deals with that document', async () => {
    const { checkFindings } = await checker();
    const stale = checkFindings(CORPUS, [
      { severity: 'high', document: 'msa.pdf', location: 'page 2', quote: 'limited to the Fees paid in the 3 months', finding: 'The liability cap is only 3 months.' },
    ]);
    expect(stale.ok).toBe(false);
    expect(stale.issues[0]!.problem).toContain('clause 10.1 that this quotes was replaced by amendment.pdf (page 1)');

    const handled = checkFindings(CORPUS, [
      { severity: 'low', document: 'msa.pdf', location: 'page 2', quote: 'limited to the Fees paid in the 3 months', finding: 'The 3-month cap no longer applies: amendment.pdf raised it.' },
    ]);
    expect(handled.ok).toBe(true);
  });

  it('writes a report whose summary is copied from the checked findings', async () => {
    const { checkFindings, findingsTable, renderReport, summarize } = await checker();
    const report = checkFindings(CORPUS, [
      { severity: 'low', document: 'policy.md', location: '§ 2. Data protection', quote: 'within 72 hours', finding: 'Policy asks for 72 hours.' },
      { severity: 'high', document: 'msa.pdf', location: 'page 2', quote: 'for convenience on 30 days', finding: 'Courier can leave on 30 days.', policy: 'policy.md 3.3' },
    ]);
    expect(summarize(report.rows)).toBe('Act on these first:\n1. Courier can leave on 30 days. (msa.pdf, page 2)');
    expect(summarize(report.rows.filter((row) => row.severity === 'low'))).toBe(
      'Nothing is high. Look at these first:\n1. Policy asks for 72 hours. (policy.md, § 2. Data protection)',
    );

    const markdown = renderReport(CORPUS, report, '2026-10-23');
    expect(markdown).toContain('Reviewed 2026-10-23. Read 3 documents');
    expect(markdown).toContain('1 high, 0 medium and 1 low findings.');
    expect(markdown).toContain('| 1 | high | Courier can leave on 30 days. | msa.pdf, page 2 |');
    expect(markdown).toContain('> for convenience on 30 days');
    expect(markdown).toContain('Policy: policy.md 3.3');
    expect(markdown).toContain('| logo.png | skipped | unsupported file type | 0 |');

    const table = findingsTable(report.rows);
    expect(table.title).toBe('Findings (2)');
    expect(table.columns.map((column) => column.key)).toEqual(['severity', 'finding', 'where', 'quote']);
    expect(table.data[0]).toEqual({ severity: 'high', finding: 'Courier can leave on 30 days.', where: 'msa.pdf, page 2', quote: '"for convenience on 30 days"' });
  });
});
