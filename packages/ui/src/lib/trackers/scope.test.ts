import { describe, expect, test } from 'bun:test';

import { localTrackerDescriptor, linearLikeTrackerDescriptor } from './descriptor.fixture';
import { scopedByProject, trackerScopeOf } from './scope';

const LOCAL = localTrackerDescriptor();
const LINEAR = linearLikeTrackerDescriptor();
const CONTAINERS = [{ id: 'team-a' }, { id: 'team-b' }];

describe('scopedByProject', () => {
  test('a tracker whose containers are the projects follows the board', () => {
    expect(scopedByProject(LOCAL)).toBe(true);
  });

  test('a tracker with containers of its own keeps its picker', () => {
    expect(scopedByProject(LINEAR)).toBe(false);
    expect(scopedByProject(null)).toBe(false);
  });
});

describe('trackerScopeOf', () => {
  test('a project-scoped tracker lists the project the board shows', () => {
    // Even with a team remembered from another tab, the project wins.
    expect(trackerScopeOf(LOCAL, { id: 'proj-1' }, 'team-a', CONTAINERS)).toBe('proj-1');
  });

  test('a board with no project falls back to every container', () => {
    expect(trackerScopeOf(LOCAL, null, 'team-a', CONTAINERS)).toBeNull();
  });

  test('a tracker with its own containers keeps the chosen one while it exists', () => {
    expect(trackerScopeOf(LINEAR, { id: 'proj-1' }, 'team-b', CONTAINERS)).toBe('team-b');
    // A container that is gone (another account) reads as every container,
    // not as an empty list.
    expect(trackerScopeOf(LINEAR, { id: 'proj-1' }, 'team-gone', CONTAINERS)).toBeNull();
    expect(trackerScopeOf(LINEAR, { id: 'proj-1' }, null, CONTAINERS)).toBeNull();
  });
});
