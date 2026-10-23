import { describe, expect, it } from 'vitest';
import { checkLeaks, diffFacts } from '../leak-check.js';

const FIX = `--- a/fastapi/dependencies/utils.py
+++ b/fastapi/dependencies/utils.py
@@ -810,7 +810,9 @@ def _get_multidict_value(field, values, alias=None):
     value = values.get(alias, None)
-    if value is None or (isinstance(field.field_info, params.Form) and value == ""):
+    if value is None or (
+        isinstance(field.field_info, params.Form) and value == "" and not _is_json_field(field)
+    ):
         return None
`;

const TESTS = `from fastapi import FastAPI, Form
from fastapi.testclient import TestClient
from pydantic import Json

def test_json_list_form():
    app = FastAPI()
`;

function check(instruction: string) {
  return checkLeaks({
    instruction,
    fixDiff: FIX,
    sourceFiles: ['fastapi/dependencies/utils.py'],
    testSource: TESTS,
    testFiles: ['tests/test_form_json.py'],
    failToPass: ['tests/test_form_json.py::test_json_list_form'],
  });
}

describe('checkLeaks', () => {
  it('passes a symptom-only issue that uses public API', () => {
    const report = check(`# Json[list[str]] in a Form field is rejected

Declaring \`tags: Json[list[str]] = Form()\` on a FastAPI endpoint and posting \`tags=["a","b"]\`
returns 422 instead of the parsed list.`);
    expect(report).toEqual({ clean: true, leaks: [] });
  });

  it('flags the changed file, by path and by module', () => {
    expect(check('The problem is in fastapi/dependencies/utils.py.').leaks.map((l) => l.kind)).toContain('file_path');
    expect(check('Look at fastapi.dependencies.utils for the cause.').leaks[0]).toMatchObject({ kind: 'file_path', text: 'fastapi.dependencies.utils' });
    expect(check('Something in utils.py drops the value.').leaks[0]).toMatchObject({ kind: 'file_path', text: 'utils.py' });
  });

  it('flags private helpers the fix edits or introduces', () => {
    const edited = check('_get_multidict_value returns None for the field.');
    expect(edited.leaks[0]).toMatchObject({ kind: 'changed_symbol', text: '_get_multidict_value' });
    const introduced = check('It should check _is_json_field before treating "" as missing.');
    expect(introduced.leaks.map((l) => l.text)).toContain('_is_json_field');
  });

  it('flags a quoted diff line regardless of whitespace', () => {
    const report = check('The line `if value is None or   (isinstance(field.field_info, params.Form) and value == ""):` is wrong.');
    expect(report.leaks.some((l) => l.kind === 'diff_line')).toBe(true);
  });

  it('flags hidden test names and files', () => {
    expect(check('Make test_json_list_form pass.').leaks[0]).toMatchObject({ kind: 'hidden_test' });
    expect(check('See tests/test_form_json.py.').leaks[0]).toMatchObject({ kind: 'hidden_test' });
  });

  it('allows names the hidden tests use', () => {
    expect(check('Using Form with Json fails.').clean).toBe(true);
  });
});

describe('diffFacts', () => {
  it('collects the functions a hunk sits in and the changed lines', () => {
    const facts = diffFacts(FIX);
    expect([...facts.changedSymbols]).toEqual(['_get_multidict_value']);
    expect(facts.added).toHaveLength(3);
    expect(facts.removed).toHaveLength(1);
  });
});
