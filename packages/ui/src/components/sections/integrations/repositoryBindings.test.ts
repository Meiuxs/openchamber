import { describe, expect, test } from 'bun:test';
import type { SourceControlBindingRead, SourceControlProviderBinding } from '@/lib/api/types';
import { bindMutation, bindingTargetForRead, duplicateGroups, providerMutationOf, resetIntent, restoreMutation } from './repositoryBindings';

const base = (directory: string) => ({
  revision: 7,
  repository: {
    repositoryId: `repo:${directory}`,
    configRevision: 'config-1',
    bare: false,
    remotes: [{ name: 'origin', fetch: { displayUrl: 'url', fingerprint: 'fp' }, push: { displayUrl: 'url', fingerprint: 'fp' } }],
  },
});

const read = (directory: string, provider?: SourceControlProviderBinding): SourceControlBindingRead => {
  if (!provider) return { ...base(directory), status: 'missing', binding: null };
  return {
    ...base(directory),
    status: 'bound',
    binding: {
      repositoryId: `repo:${directory}`,
      revision: 7,
      providers: [{ ...provider, readiness: 'ready', endpoint: null }],
      remotes: [],
      auxiliary: [],
      state: 'bound',
      configRevision: 'config-1',
    },
  };
};

const gitlab = (owner: string, name: string, accountId = 'acct#1'): SourceControlProviderBinding => ({
  provider: 'gitlab', instance: 'https://gitlab.example.com', accountId, primaryRemote: 'origin',
  repository: { owner, name },
});

describe('repository binding helpers', () => {
  test('groups directories that resolve to the same provider instance and project', () => {
    const groups = duplicateGroups([
      { directory: '/code/a', read: read('/code/a', gitlab('root', 'openchamber')), error: null, loading: false },
      { directory: '/code/b', read: read('/code/b', gitlab('root', 'OpenChamber')), error: null, loading: false },
      { directory: '/code/c', read: read('/code/c', gitlab('other', 'app')), error: null, loading: false },
    ]);
    expect([...groups.keys()]).toHaveLength(1);
    expect(groups.values().next().value?.members.map((row) => row.directory)).toEqual(['/code/a', '/code/b']);
  });

  test('does not group the same project name on different instances or accounts', () => {
    const groups = duplicateGroups([
      { directory: '/code/a', read: read('/code/a', gitlab('root', 'app')), error: null, loading: false },
      { directory: '/code/b', read: read('/code/b', { ...gitlab('root', 'app'), instance: 'https://gitlab.other' }), error: null, loading: false },
      { directory: '/code/c', read: read('/code/c', gitlab('root', 'app', 'acct#2')), error: null, loading: false },
    ]);
    expect(groups.size).toBe(0);
  });

  test('strips read-only fields from a provider mutation', () => {
    const enriched = { ...gitlab('root', 'app'), readiness: 'ready', endpoint: null };
    expect(providerMutationOf(enriched)).toEqual(gitlab('root', 'app'));
  });

  test('infers the provider and remote from an unbound repository', () => {
    const unbound: SourceControlBindingRead = {
      ...base('/code/app'),
      status: 'missing',
      binding: null,
      repository: {
        ...base('/code/app').repository,
        remotes: [{ name: 'origin', fetch: { displayUrl: 'https://gitlab.example.com/root/app.git', fingerprint: 'fp' }, push: { displayUrl: 'https://gitlab.example.com/root/app.git', fingerprint: 'fp' } }],
      },
    };
    const identities = [{ provider: 'gitlab' as const, instance: 'https://gitlab.example.com' }];
    expect(bindingTargetForRead(unbound, identities)).toEqual({
      identity: identities[0],
      primaryRemote: 'origin',
    });
  });

  test('builds an add mutation using the inferred remote', () => {
    const unbound = read('/code/app');
    expect(bindMutation('/code/app', unbound, { identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' }, primaryRemote: 'upstream' }, 'acct#1')).toEqual({
      directory: '/code/app',
      expectedRepositoryId: 'repo:/code/app',
      expectedRevision: 7,
      operation: 'add',
      provider: { provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'acct#1', primaryRemote: 'upstream' },
    });
  });

  test('builds a reset intent from the read authority', () => {
    const value = read('/code/a', gitlab('root', 'app'));
    expect(resetIntent('/code/a', value)).toEqual({
      directory: '/code/a',
      expectedRepositoryId: 'repo:/code/a',
      expectedRevision: 7,
      expectedConfigRevision: 'config-1',
      confirmed: true,
    });
  });

  test('builds an add mutation to restore a captured provider binding', () => {
    const provider = gitlab('root', 'app');
    const current = read('/code/a');
    expect(restoreMutation('/code/a', current, provider)).toEqual({
      directory: '/code/a',
      expectedRepositoryId: 'repo:/code/a',
      expectedRevision: 7,
      operation: 'add',
      provider,
    });
  });
});
