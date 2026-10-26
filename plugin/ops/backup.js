'use strict';
/**
 * Timeline backup before significant transformations: duplicate the timeline
 * (inside the same project), then make sure the user's original timeline is
 * still the current one. The backup's name is recorded in the operation log.
 */
const { SuiteError } = require('../resolve/adapter');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function backupTimeline(a, project, timeline, reason) {
  const original = await a.call('Timeline', timeline, 'GetName');
  const name = `${original} [backup ${stamp()}${reason ? ' ' + reason : ''}]`;
  const dup = await a.call('Timeline', timeline, 'DuplicateTimeline', name);
  if (!dup) throw new SuiteError(`Could not create a backup of "${original}". Nothing was changed.`, 'call-failed');
  // Duplicating may switch the current timeline; restore the original.
  const cur = await a.call('Project', project, 'GetCurrentTimeline');
  const curName = cur ? await a.call('Timeline', cur, 'GetName') : null;
  if (curName !== original) {
    await a.must('Project', project, 'SetCurrentTimeline', timeline);
  }
  return { backupName: name, original };
}

module.exports = { backupTimeline, stamp };
