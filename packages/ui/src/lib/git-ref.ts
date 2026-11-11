/** Git ref rules shared by the GitLab issue settings inputs. */
const hasRefSpecialChar = (name: string): boolean => {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
    if ('~^:?*[\\'.includes(char)) return true;
  }
  return false;
};

const isValidGitRefName = (name: string): boolean => {
  if (!name || name.length > 255) return false;
  if (name === '@' || name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('/')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (hasRefSpecialChar(name)) return false;
  return name.split('/').every((component) => component.length > 0
    && !component.startsWith('.') && !component.endsWith('.') && !component.endsWith('.lock'));
};

export const isValidBranchPrefix = (prefix: string): boolean => prefix.endsWith('/')
  && !prefix.startsWith('/') && isValidGitRefName(`${prefix}issue-1-x`);
