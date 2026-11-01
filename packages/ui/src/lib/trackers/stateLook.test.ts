import { describe, expect, test } from 'bun:test';

import type { I18nKey } from '@/lib/i18n';
import { trackerStateLabel } from './stateLook';

// The board's Chinese words for the six generated states, so a translation is
// visibly different from the slug it replaces. Anything else reads as its key.
const t = (key: I18nKey): string => {
  switch (key) {
    case 'references.picker.filter.tracker.state.triage': return '分诊';
    case 'references.picker.filter.tracker.state.backlog': return '待办池';
    case 'references.picker.filter.tracker.state.todo': return '待办';
    case 'references.picker.filter.tracker.state.inProgress': return '进行中';
    case 'references.picker.filter.tracker.state.done': return '已完成';
    case 'references.picker.filter.tracker.state.canceled': return '已取消';
    default: return key;
  }
};

describe('trackerStateLabel', () => {
  test('a tracker that generates its names gets the board words', () => {
    expect(trackerStateLabel({ id: 'triage', name: 'triage', category: 'triage' }, t, true)).toBe('分诊');
    expect(trackerStateLabel({ id: 'backlog', name: 'backlog', category: 'backlog' }, t, true)).toBe('待办池');
    expect(trackerStateLabel({ id: 'todo', name: 'todo', category: 'todo' }, t, true)).toBe('待办');
    expect(trackerStateLabel({ id: 'in-progress', name: 'in-progress', category: 'in-progress' }, t, true)).toBe('进行中');
    expect(trackerStateLabel({ id: 'done', name: 'done', category: 'done' }, t, true)).toBe('已完成');
    expect(trackerStateLabel({ id: 'canceled', name: 'canceled', category: 'canceled' }, t, true)).toBe('已取消');
  });

  test('a tracker whose names a team wrote is shown as written', () => {
    // Linear's own state: translating it would rename someone's workflow.
    expect(trackerStateLabel({ id: 'started', name: 'In Progress', category: 'in-progress' }, t, false)).toBe('In Progress');
    // Even an id the board has words for stays as written without the capability.
    expect(trackerStateLabel({ id: 'done', name: 'Shipped', category: 'done' }, t, false)).toBe('Shipped');
  });

  test('falls back to the id-derived category, then to the name', () => {
    // A generated state that arrived without an id still reads through its category.
    expect(trackerStateLabel({ id: null, name: 'in-progress', category: 'in-progress' }, t, true)).toBe('进行中');
    // A state this version has no words for keeps its own name.
    expect(trackerStateLabel({ id: 'blocked', name: 'blocked', category: null }, t, true)).toBe('blocked');
    expect(trackerStateLabel({ name: '' }, t, true)).toBe('');
  });
});
