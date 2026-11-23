import * as gitHttp from './gitApiHttp';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { GitNetworkOperationRequestError } from './api/types';
import type { GetGitDiffOptions, GitPathDiffResponse } from './api/types';

export async function getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitPathDiffResponse> {
  const runtime = getRegisteredRuntimeAPIs()?.git ?? null;
  if (runtime) {
    return runtime.getGitDiff
      ? runtime.getGitDiff(directory, options)
      : Promise.reject(new GitNetworkOperationRequestError('RUNTIME_UNSUPPORTED', 'getGitDiff is not supported in this runtime', 501));
  }
  return gitHttp.getGitDiff(directory, options);
}
