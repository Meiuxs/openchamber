import { isString } from './validation.js';

export const labelFilter = (labels: string[] | undefined) => {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  if (labels.some((label) => !isString(label) || label.includes(','))) {
    throw Object.assign(new Error('A GitLab label name cannot contain a comma'), {
      code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
    });
  }
  return labels.join(',');
};
