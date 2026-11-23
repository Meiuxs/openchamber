import type { GitStatus } from '@/lib/api/types';
import { findFileRepository } from '@/lib/nestedRepositories';
import { isSameRepoFile } from '@/lib/path-utils';

export const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

export const isUnstagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

export const diffCacheKey = (path: string, staged: boolean): string => staged ? `${path}\u0000staged` : path;

export const switchedCommitRequests = new WeakSet<object>();
export const takenCommitRequests = new WeakSet<object>();

export const closestRepoFile = (file: string, directory: string, listed: readonly (string | undefined)[]): string | undefined => listed
  .filter((path): path is string => isSameRepoFile(file, directory, path))
  .sort((a, b) => a.length - b.length)[0];

export const changesRepositoryHolder = (
  file: string,
  rootDirectory: string | undefined,
  rootIsGitRepo: boolean | null,
  repositoryOptions: string[] | null,
) => findFileRepository(file, [
  ...(rootIsGitRepo && rootDirectory ? [rootDirectory] : []),
  ...(repositoryOptions ?? []),
]);
