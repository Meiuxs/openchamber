import { isString } from './guards.js';

// Git's check-ref-format rules, written as a predicate so the settings
// sanitizer can validate a prefix without spawning a process.
export const isValidGitRefName = (name) => {
  if (!isString(name) || !name || name.length > 255) return false;
  if (name === '@' || name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('/')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
  return name.split('/').every((component) => component
    && !component.startsWith('.') && !component.endsWith('.') && !component.endsWith('.lock'));
};

export const isValidBranchPrefix = (prefix) => isString(prefix)
  && prefix.endsWith('/') && !prefix.startsWith('/') && isValidGitRefName(`${prefix}issue-1-x`);
