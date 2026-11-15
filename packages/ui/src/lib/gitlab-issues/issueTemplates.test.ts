import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_ISSUE_TEMPLATES,
  builtinIssueTemplateDefaults,
  resolveIssueTemplates,
  toStoredIssueTemplates,
  type BuiltinIssueTemplateNameKey,
} from './issueTemplates';

const nameOf = (key: BuiltinIssueTemplateNameKey) => (
  key === 'gitlabIssue.template.builtinBug' ? 'Bug report' : 'Feature request'
);

describe('issue templates', () => {
  test('built-in bodies carry no header the server owns', () => {
    // The server prefixes `类型:` and `目标分支:` from the form; a body that
    // repeated them would file an issue with two conflicting headers.
    for (const template of BUILTIN_ISSUE_TEMPLATES) {
      expect(template.body).not.toContain('类型:');
      expect(template.body).not.toContain('目标分支:');
      expect(template.body.startsWith('## ')).toBe(true);
    }
  });

  test('a project without stored templates offers both built-ins', () => {
    const resolved = resolveIssueTemplates(undefined, nameOf);
    expect(resolved.map((entry) => entry.id)).toEqual(['builtin-bug', 'builtin-feature']);
    expect(resolved.map((entry) => entry.name)).toEqual(['Bug report', 'Feature request']);
    expect(resolved.every((entry) => entry.builtin)).toBe(true);
  });

  test('a stored entry with a built-in id overrides it, a new id appends', () => {
    const resolved = resolveIssueTemplates([
      { id: 'builtin-bug', name: 'Our bug', kind: 'feature', body: '## Mine' },
      { id: 'custom-1', name: 'Team', kind: null, body: '## Team' },
    ], nameOf);

    expect(resolved).toHaveLength(3);
    expect(resolved[0]).toMatchObject({ id: 'builtin-bug', name: 'Our bug', kind: 'feature', body: '## Mine' });
    expect(resolved[2]).toMatchObject({ id: 'custom-1', name: 'Team', kind: null, builtin: false });
  });

  test('untouched built-ins store nothing, an edited built-in stores the whole entry', () => {
    const untouched = resolveIssueTemplates(undefined, nameOf);
    expect(toStoredIssueTemplates(untouched, nameOf)).toEqual([]);

    const edited = resolveIssueTemplates(undefined, nameOf);
    edited[0] = { ...edited[0], body: '## Custom' };
    expect(toStoredIssueTemplates(edited, nameOf)).toEqual([
      { id: 'builtin-bug', name: 'Bug report', kind: 'bug', body: '## Custom' },
    ]);
  });

  test('a nameless custom template is dropped and reset restores the default text', () => {
    const withBlank = [
      ...resolveIssueTemplates(undefined, nameOf),
      { id: 'custom-2', name: '   ', kind: null, body: '', builtin: false },
    ];
    expect(toStoredIssueTemplates(withBlank, nameOf)).toEqual([]);
    expect(builtinIssueTemplateDefaults('builtin-feature', nameOf)).toMatchObject({
      id: 'builtin-feature',
      name: 'Feature request',
      kind: 'feature',
    });
  });
});
