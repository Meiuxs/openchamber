import type { TrackerDescriptor } from './types';

/**
 * Where a tracker tab's list is scoped. A tracker whose containers are the
 * projects (Local reads `.issues/` inside one) follows the project the board
 * shows, so the project picker is the scope picker. One with containers of its
 * own (Linear's team) follows the container chosen in its own picker.
 */
export const scopedByProject = (
  descriptor: Pick<TrackerDescriptor, 'capabilities'> | null,
): boolean => descriptor?.capabilities.containersAreProjects === true;

/**
 * The container a list is read for. The project itself where the containers
 * are projects, whatever the tab remembers from an earlier tracker; otherwise
 * the remembered container while it still exists, else every container.
 */
export const trackerScopeOf = (
  descriptor: Pick<TrackerDescriptor, 'capabilities'> | null,
  project: { id: string } | null,
  storedContainerId: string | null,
  containers: readonly { id: string }[],
): string | null => {
  if (scopedByProject(descriptor)) return project?.id ?? null;
  return storedContainerId && containers.some((container) => container.id === storedContainerId) ? storedContainerId : null;
};
