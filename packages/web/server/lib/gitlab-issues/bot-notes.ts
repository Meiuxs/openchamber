import { withBotMarker } from './gitlab.js';
import type { GitlabIssueApi } from './gitlab.js';

export const withBotNoteMarker = (api: GitlabIssueApi): GitlabIssueApi => ({
  ...api,
  postNote: (projectId: string | number, iid: number, body: string) => api.postNote(projectId, iid, withBotMarker(body)),
  postMergeRequestNote: (projectId: string | number, iid: number, body: string) => api.postMergeRequestNote(projectId, iid, withBotMarker(body)),
});
