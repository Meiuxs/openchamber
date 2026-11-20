import { isPlainObject } from '../shared/guards.js';
import { createLocalTracker, LOCAL_TRACKER_DESCRIPTOR } from './tracker.js';

import type { Project } from './scanner.js';
import type { TrackerEntry } from '../trackers/tracker-contract.js';

type SettingsSnapshot = { projects?: unknown };
type SettingsReader = () => Promise<SettingsSnapshot | null>;

let readSettings: SettingsReader | null = null;

export const configureLocalTracker = ({ readSettings: reader }: { readSettings: SettingsReader }): void => {
  readSettings = reader;
};

export const localTracker: TrackerEntry = {
  descriptor: LOCAL_TRACKER_DESCRIPTOR,
  load: async () => {
    const reader = readSettings;
    if (!reader) {
      throw new Error('The local tracker is not configured: the server must call configureLocalTracker({ readSettings }) at startup');
    }
    const listProjects = async (): Promise<Project[]> => {
      const settings = await reader();
      const projects = isPlainObject(settings) && Array.isArray(settings.projects) ? settings.projects : [];
      // SAFETY: settings.projects holds sanitized project entries produced by the settings layer at startup.
      return projects as Project[];
    };
    return createLocalTracker({ listProjects });
  },
};
