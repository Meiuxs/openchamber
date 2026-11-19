import { normalizeOriginInstance } from '../source-control/origin-instance.js';

export function normalizeGitLabInstance(value: string, options: { insecureOrigins?: Set<string> | null } = {}) {
  return normalizeOriginInstance(value, { label: 'GitLab', ...options });
}
