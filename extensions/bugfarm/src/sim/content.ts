/**
 * Synthetic but realistic content for the simulator: bug-fix commits from a
 * made-up Python library, `orchard/pyline`. Nothing here describes a real
 * repository's history.
 */

export const SIM_REPO = 'orchard/pyline';

export interface FixTemplate {
  title: string;
  file: string;
  test: string;
  before: string[];
  after: string[];
  context: [string[], string[]];
  testBody: string[];
  failure: string;
}

export const FIX_TEMPLATES: FixTemplate[] = [
  {
    title: 'Fix wrap dropping the last wide glyph at the column edge',
    file: 'pyline/wrap.py',
    test: 'tests/test_wrap.py::test_wide_glyph_at_boundary',
    context: [
      ['def wrap_line(text: str, width: int) -> list[str]:', '    lines, current, used = [], [], 0', '    for char in text:', '        size = cell_width(char)'],
      ['            current, used = [char], size', '            continue', '        current.append(char)', '        used += size'],
    ],
    before: ['        if used + size >= width:', '            lines.append("".join(current))'],
    after: ['        if used + size > width:', '            lines.append("".join(current))'],
    testBody: ['def test_wide_glyph_at_boundary():', '    assert wrap_line("ab漢", 4) == ["ab漢"]'],
    failure: "AssertionError: assert ['ab', '漢'] == ['ab漢']\n  At index 0 diff: 'ab' != 'ab漢'\n  Right contains one less item: '漢'",
  },
  {
    title: 'Keep trailing whitespace when a span ends mid-line',
    file: 'pyline/spans.py',
    test: 'tests/test_spans.py::test_trailing_space_preserved',
    context: [
      ['class Span:', '    def render(self, text: str) -> str:', '        segment = text[self.start:self.end]'],
      ['        return self.style.apply(segment)', '', '    def __len__(self) -> int:', '        return self.end - self.start'],
    ],
    before: ['        segment = segment.rstrip()'],
    after: ['        if self.end >= len(text):', '            segment = segment.rstrip("\\n")'],
    testBody: ['def test_trailing_space_preserved():', '    span = Span(0, 4, style=PLAIN)', '    assert span.render("ab  cd") == "ab  "'],
    failure: "AssertionError: assert 'ab' == 'ab  '\n  - ab  \n  + ab",
  },
  {
    title: 'Fix negative padding when a table column is narrower than its header',
    file: 'pyline/table.py',
    test: 'tests/test_table.py::test_narrow_column_header',
    context: [
      ['def pad_cell(text: str, width: int, align: str = "left") -> str:', '    gap = width - cell_len(text)'],
      ['    if align == "right":', '        return " " * gap + text', '    return text + " " * gap'],
    ],
    before: ['    if gap == 0:', '        return text'],
    after: ['    if gap <= 0:', '        return truncate(text, width)'],
    testBody: ['def test_narrow_column_header():', '    assert pad_cell("Latency", 4) == "Lat…"'],
    failure: "AssertionError: assert 'Latency' == 'Lat…'\n  - Lat…\n  + Latency",
  },
  {
    title: 'Stop markup parser from swallowing an escaped closing bracket',
    file: 'pyline/markup.py',
    test: 'tests/test_markup.py::test_escaped_close_bracket',
    context: [
      ['def tokenize(markup: str):', '    position = 0', '    for match in TAG_RE.finditer(markup):', '        start, end = match.span()'],
      ['        yield Text(markup[position:start])', '        yield Tag(match.group(1))', '        position = end'],
    ],
    before: ['        if markup[start - 1] == "\\\\":'],
    after: ['        if start > 0 and markup[start - 1] == "\\\\" and not _double_escaped(markup, start):'],
    testBody: ['def test_escaped_close_bracket():', '    tokens = list(tokenize(r"a \\[b] c"))', '    assert render(tokens) == "a [b] c"'],
    failure: "AssertionError: assert 'a b c' == 'a [b] c'\n  - a [b] c\n  ?   - -\n  + a b c",
  },
  {
    title: 'Fix progress bar overshooting 100% on the final update',
    file: 'pyline/progress.py',
    test: 'tests/test_progress.py::test_complete_is_exactly_full',
    context: [
      ['    def advance(self, amount: float = 1) -> None:', '        with self._lock:'],
      ['            self._refresh()', '', '    @property', '    def fraction(self) -> float:'],
    ],
    before: ['            self.completed += amount'],
    after: ['            self.completed = min(self.total, self.completed + amount)'],
    testBody: ['def test_complete_is_exactly_full():', '    bar = Progress(total=3)', '    for _ in range(4):', '        bar.advance()', '    assert bar.fraction == 1.0'],
    failure: 'AssertionError: assert 1.3333333333333333 == 1.0\n +  where 1.3333333333333333 = <Progress 4/3>.fraction',
  },
  {
    title: 'Respect NO_COLOR when the terminal reports truecolor',
    file: 'pyline/console.py',
    test: 'tests/test_console.py::test_no_color_beats_colorterm',
    context: [
      ['def detect_color_system(env: Mapping[str, str]) -> ColorSystem:'],
      ['    if env.get("COLORTERM") in ("truecolor", "24bit"):', '        return ColorSystem.TRUECOLOR', '    return ColorSystem.STANDARD'],
    ],
    before: ['    if env.get("TERM") == "dumb":', '        return ColorSystem.NONE'],
    after: ['    if env.get("NO_COLOR") or env.get("TERM") == "dumb":', '        return ColorSystem.NONE'],
    testBody: ['def test_no_color_beats_colorterm():', '    env = {"NO_COLOR": "1", "COLORTERM": "truecolor"}', '    assert detect_color_system(env) is ColorSystem.NONE'],
    failure: 'AssertionError: assert <ColorSystem.TRUECOLOR: 3> is <ColorSystem.NONE: 0>',
  },
  {
    title: 'Fix off-by-one in syntax highlighter line numbers after a blank line',
    file: 'pyline/syntax.py',
    test: 'tests/test_syntax.py::test_line_numbers_skip_nothing',
    context: [
      ['    def numbered(self, code: str):', '        number = self.start_line'],
      ['            yield number, line', '            number += 1'],
    ],
    before: ['        for line in code.splitlines():', '            if not line:', '                continue'],
    after: ['        for line in code.splitlines():'],
    testBody: ['def test_line_numbers_skip_nothing():', '    numbers = [n for n, _ in Syntax(start_line=1).numbered("a\\n\\nb")]', '    assert numbers == [1, 2, 3]'],
    failure: 'AssertionError: assert [1, 2] == [1, 2, 3]\n  Right contains one more item: 3',
  },
  {
    title: 'Handle zero-width joiners in emoji cell width',
    file: 'pyline/cells.py',
    test: 'tests/test_cells.py::test_zwj_sequence_is_two_cells',
    context: [
      ['def cell_len(text: str) -> int:', '    total = 0'],
      ['    return total'],
    ],
    before: ['    for char in text:', '        total += char_width(char)'],
    after: ['    for cluster in grapheme_clusters(text):', '        total += cluster_width(cluster)'],
    testBody: ['def test_zwj_sequence_is_two_cells():', '    assert cell_len("👩‍💻") == 2'],
    failure: 'AssertionError: assert 4 == 2\n +  where 4 = cell_len(\'👩\\u200d💻\')',
  },
  {
    title: 'Fix live display leaving a stale line when height shrinks',
    file: 'pyline/live.py',
    test: 'tests/test_live.py::test_shrinking_render_clears_tail',
    context: [
      ['    def _redraw(self, lines: list[str]) -> None:', '        out = [CURSOR_UP * self._height]'],
      ['        out.extend(line + ERASE_LINE for line in lines)', '        self._height = len(lines)', '        self.file.write("".join(out))'],
    ],
    before: [],
    after: ['        stale = self._height - len(lines)', '        if stale > 0:', '            lines = lines + [""] * stale'],
    testBody: ['def test_shrinking_render_clears_tail(fake_term):', '    live = Live(file=fake_term)', '    live.update(["a", "b", "c"])', '    live.update(["a"])', '    assert fake_term.screen == ["a", "", ""]'],
    failure: "AssertionError: assert ['a', 'b', 'c'] == ['a', '', '']\n  At index 1 diff: 'b' != ''",
  },
  {
    title: 'Fix JSON pretty-printer reordering keys when sort_keys is false',
    file: 'pyline/pretty.py',
    test: 'tests/test_pretty.py::test_key_order_kept',
    context: [
      ['def pretty_json(data, *, indent: int = 2, sort_keys: bool = False) -> str:'],
      ['    return highlight(text, lexer="json")'],
    ],
    before: ['    text = json.dumps(data, indent=indent, sort_keys=True)'],
    after: ['    text = json.dumps(data, indent=indent, sort_keys=sort_keys)'],
    testBody: ['def test_key_order_kept():', '    out = strip_style(pretty_json({"b": 1, "a": 2}))', '    assert out.index(\'"b"\') < out.index(\'"a"\')'],
    failure: 'AssertionError: assert 18 < 5\n +  where 18 = <built-in method index of str object>(\'"b"\')',
  },
  {
    title: 'Fix tree guides misaligned under a multi-line label',
    file: 'pyline/tree.py',
    test: 'tests/test_tree.py::test_multiline_label_guides',
    context: [
      ['    def _render_label(self, label: str, prefix: str):', '        first, *rest = label.splitlines() or [""]', '        yield prefix + first'],
      ['', '    def render(self):', '        yield from self._walk(self.root, "")'],
    ],
    before: ['        for line in rest:', '            yield " " * len(prefix) + line'],
    after: ['        continuation = prefix.replace("├── ", "│   ").replace("└── ", "    ")', '        for line in rest:', '            yield continuation + line'],
    testBody: ['def test_multiline_label_guides():', '    tree = Tree("root")', '    tree.add("one\\ntwo")', '    tree.add("three")', '    assert render(tree)[2] == "│   two"'],
    failure: "AssertionError: assert '    two' == '│   two'\n  - │   two\n  + ····two",
  },
  {
    title: 'Fix markdown renderer losing the ordered list start number',
    file: 'pyline/markdown.py',
    test: 'tests/test_markdown.py::test_ordered_list_start',
    context: [
      ['    def _list(self, token) -> Iterator[str]:', '        ordered = token.attrs.get("ordered", False)'],
      ['        for offset, item in enumerate(token.children):', '            marker = f"{start + offset}." if ordered else "•"', '            yield f"{marker} {self._inline(item)}"'],
    ],
    before: ['        start = 1'],
    after: ['        start = int(token.attrs.get("start", 1))'],
    testBody: ['def test_ordered_list_start():', '    assert render_md("3. three\\n4. four").splitlines()[0] == "3. three"'],
    failure: "AssertionError: assert '1. three' == '3. three'\n  - 3. three\n  ? ^\n  + 1. three",
  },
];

/** A plausible 40-hex sha from a seeded random source. */
export function fakeSha(random: () => number): string {
  let out = '';
  for (let i = 0; i < 40; i += 1) out += Math.floor(random() * 16).toString(16);
  return out;
}

export function renderDiff(template: FixTemplate, line: number): { diff: string; stats: { files: number; additions: number; deletions: number } } {
  const [lead, tail] = template.context;
  const oldCount = lead.length + template.before.length + tail.length;
  const newCount = lead.length + template.after.length + tail.length;
  const testFile = template.test.split('::')[0];
  const body = [
    `diff --git a/${template.file} b/${template.file}`,
    `--- a/${template.file}`,
    `+++ b/${template.file}`,
    `@@ -${line},${oldCount} +${line},${newCount} @@`,
    ...lead.map((text) => ` ${text}`),
    ...template.before.map((text) => `-${text}`),
    ...template.after.map((text) => `+${text}`),
    ...tail.map((text) => ` ${text}`),
    `diff --git a/${testFile} b/${testFile}`,
    `--- a/${testFile}`,
    `+++ b/${testFile}`,
    `@@ -${line + 40},0 +${line + 40},${template.testBody.length + 2} @@`,
    '+',
    '+',
    ...template.testBody.map((text) => `+${text}`),
  ];
  return {
    diff: `${body.join('\n')}\n`,
    stats: {
      files: 2,
      additions: template.after.length + template.testBody.length + 2,
      deletions: template.before.length,
    },
  };
}
