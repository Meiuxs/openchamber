import { isString } from './guards.js';

export const isValidGitRefName = (name: string): boolean => {
  if (!isString(name) || !name || name.length > 255) return false;
  if (name === '@' || name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('/')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (/[~^:?*[\\]/.test(name) || [...name].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) return false;
  return name.split('/').every((component) => component
    && !component.startsWith('.') && !component.endsWith('.') && !component.endsWith('.lock'));
};

export const isValidBranchPrefix = (prefix: string): boolean => isString(prefix)
  && prefix.endsWith('/') && !prefix.startsWith('/') && isValidGitRefName(`${prefix}issue-1-x`);
