import {describeProgress, progressAnnouncement} from './progress.js';
import {presentProgress} from './progress-view.js';

// Both browser views and the polling loop use the same privacy-safe announcement.
export function progressUiState(task, now, connection) {
  const attempt = Array.isArray(task?.attempts) ? task.attempts.at(-1) : null;
  const progress = connection === 'connected' && attempt ? describeProgress(task, attempt, now) : null;
  const view = progress ? presentProgress(progress) : null;
  let announcement = progressAnnouncement(task, progress, connection);
  if (connection === 'connected' && task?.live?.stopping === true) {
    announcement = progress?.failed
      ? 'Attempt failed. Stop is still pending confirmation.'
      : 'Stop requested. Waiting for confirmation.';
  } else if (connection === 'connected' && task?.status === 'running' && !progress) {
    announcement = 'Progress is unavailable.';
  }
  return {view, announcement};
}
