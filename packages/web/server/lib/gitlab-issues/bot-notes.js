import { withBotMarker } from './gitlab.js';

export const withBotNoteMarker = (api) => ({
  ...api,
  postNote: (projectId, iid, body) => api.postNote(projectId, iid, withBotMarker(body)),
  postMergeRequestNote: (projectId, iid, body) => api.postMergeRequestNote(projectId, iid, withBotMarker(body)),
});
