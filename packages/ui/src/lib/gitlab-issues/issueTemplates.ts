/**
 * Description templates offered when filing a GitLab issue.
 *
 * A project starts with two built-in templates. A stored entry that reuses a
 * built-in id overrides it; an entry with a new id is a custom template. Only
 * what differs from the built-in is stored, so an untouched project keeps
 * receiving built-in fixes and an empty field brings the defaults back.
 *
 * The built-in bodies mirror `docs/gitlab-issue-templates/{Bug,Feature}.md`
 * without their header: the `类型:` and `目标分支:` lines the dispatcher reads
 * are written by the server from the form's own fields, so a body that repeated
 * them would file an issue with two conflicting headers. The bodies stay in the
 * language that header protocol uses, which is also the language of the issue
 * the automation consumes; a project that wants another one edits the body.
 */

export type GitlabIssueTemplateKind = 'bug' | 'feature';

interface GitlabIssueTemplate {
  id: string;
  name: string;
  kind: GitlabIssueTemplateKind | null;
  body: string;
}

/** Built-in name key; resolved by the caller so the text follows the UI locale. */
export type BuiltinIssueTemplateNameKey =
  | 'gitlabIssue.template.builtinBug'
  | 'gitlabIssue.template.builtinFeature';

interface BuiltinIssueTemplate {
  id: string;
  nameKey: BuiltinIssueTemplateNameKey;
  kind: GitlabIssueTemplateKind;
  body: string;
}

const BUG_BODY = [
  '## 现象',
  '',
  '## 复现步骤',
  '',
  '## 期望结果',
  '',
  '## 实际结果',
  '',
  '## 环境',
  '',
  '## 证据',
  '',
  '## 影响范围',
  '',
  '## 可能根因（可选）',
].join('\n');

const FEATURE_BODY = [
  '## 背景',
  '',
  '## 期望行为',
  '',
  '## 验收标准',
  '',
  '## 不做的范围',
  '',
  '## 依赖与风险',
].join('\n');

export const BUILTIN_ISSUE_TEMPLATES: readonly BuiltinIssueTemplate[] = [
  { id: 'builtin-bug', nameKey: 'gitlabIssue.template.builtinBug', kind: 'bug', body: BUG_BODY },
  { id: 'builtin-feature', nameKey: 'gitlabIssue.template.builtinFeature', kind: 'feature', body: FEATURE_BODY },
];

const BUILTIN_IDS = new Set(BUILTIN_ISSUE_TEMPLATES.map((template) => template.id));

export type ResolvedIssueTemplate = GitlabIssueTemplate & { builtin: boolean };

type BuiltinTemplateNameResolver = (key: BuiltinIssueTemplateNameKey) => string;

/**
 * The templates a project offers, built-ins first in their fixed order followed
 * by custom ones in the order they were added.
 */
export const resolveIssueTemplates = (
  stored: readonly GitlabIssueTemplate[] | null | undefined,
  nameOf: BuiltinTemplateNameResolver,
): ResolvedIssueTemplate[] => {
  const overrides = new Map((stored ?? []).map((template) => [template.id, template]));
  const builtin = BUILTIN_ISSUE_TEMPLATES.map((template) => {
    const override = overrides.get(template.id);
    return {
      id: template.id,
      name: override?.name ?? nameOf(template.nameKey),
      kind: override ? override.kind : template.kind,
      body: override?.body ?? template.body,
      builtin: true,
    };
  });
  const custom = (stored ?? [])
    .filter((template) => !BUILTIN_IDS.has(template.id))
    .map((template) => ({ ...template, builtin: false }));
  return [...builtin, ...custom];
};

/**
 * What belongs on the project: a built-in template that still matches its
 * default is left out so the default keeps tracking the code, and a custom
 * template without a name is dropped because the store rejects it.
 */
export const toStoredIssueTemplates = (
  templates: readonly ResolvedIssueTemplate[],
  nameOf: BuiltinTemplateNameResolver,
): GitlabIssueTemplate[] => {
  return templates.flatMap((template) => {
    const name = template.name.trim();
    if (!name) return [];
    if (!template.builtin) return [{ id: template.id, name, kind: template.kind, body: template.body }];
    const builtin = BUILTIN_ISSUE_TEMPLATES.find((entry) => entry.id === template.id);
    if (!builtin) return [];
    const unchanged = name === nameOf(builtin.nameKey)
      && template.kind === builtin.kind
      && template.body === builtin.body;
    return unchanged ? [] : [{ id: template.id, name, kind: template.kind, body: template.body }];
  });
};

/** The built-in text of one template, used by its reset action. */
export const builtinIssueTemplateDefaults = (
  id: string,
  nameOf: BuiltinTemplateNameResolver,
): GitlabIssueTemplate | null => {
  const builtin = BUILTIN_ISSUE_TEMPLATES.find((template) => template.id === id);
  if (!builtin) return null;
  return { id: builtin.id, name: nameOf(builtin.nameKey), kind: builtin.kind, body: builtin.body };
};
