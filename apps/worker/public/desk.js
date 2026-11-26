const byId = (id) => document.getElementById(id);
const labels = { queued: 'Queued', next: 'Next', printing: 'Simulating', ready: 'Ready for simulated pickup' };
const errors = {
  SIMULATOR_BUSY: 'A worker command is in progress.',
  JOB_ALREADY_CLAIMED: 'A ticket is already claimed.',
  NO_CLAIMED_JOB: 'Claim a ticket first.',
  CLAIM_CHANGED: 'Another ticket was claimed. Refresh before starting it.',
  QUEUE_EMPTY: 'No waiting tickets.',
  STATUS_SYNC_PENDING: 'The worker is waiting to publish the ticket status.',
  JOB_NEEDS_RECONCILIATION: 'The active ticket is on hold. Check its worker phase.',
  LOCAL_CONTROL_ONLY: 'The control session changed. Refresh the desk.',
  TICKET_NOT_READY: 'This ticket is not ready for pickup.',
};
let capability;
let snapshot;
let pending = false;
const cursors = { queued: 0, ready: 0 };

async function run(task) {
  if (pending) return;
  pending = true;
  updateButtons();
  try {
    byId('message').textContent = '';
    await task();
  } catch (error) {
    byId('message').textContent = error.message;
  } finally {
    pending = false;
    updateButtons();
  }
}

function updateButtons() {
  const held = snapshot?.rows.some((row) => row.onHold);
  byId('refresh').disabled = pending;
  byId('claim').disabled = pending || !snapshot || snapshot.busy || held || Boolean(snapshot.claimedSubmissionId);
  byId('start').disabled = pending || !snapshot?.claimedSubmissionId || snapshot.busy || held;
  for (const button of document.querySelectorAll('tbody button, nav button')) button.disabled = pending;
}

async function read(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw Error(errors[data.error] ?? 'The desk could not complete this request. Refresh to check the ticket.');
  return data;
}

function cell(row, value) {
  const td = row.insertCell();
  td.textContent = value;
  return td;
}

async function refresh() {
  ({ capability } = await read('/session'));
  const data = await read('/queue?' + new URLSearchParams({ queuedAfter: cursors.queued, readyAfter: cursors.ready }));
  snapshot = data;
  const body = byId('rows');
  body.replaceChildren();
  for (const ticket of data.rows) {
    const tr = body.insertRow();
    cell(tr, '#' + ticket.queueNumber);
    cell(tr, ticket.onHold ? 'On hold' : labels[ticket.publicStatus]);
    const phase = cell(tr, ticket.localState?.replaceAll('_', ' ') ?? '—');
    if (ticket.notice) phase.append(Object.assign(document.createElement('small'), { textContent: ticket.notice }));
    const action = cell(tr, '');
    if (ticket.publicStatus === 'ready') {
      const button = Object.assign(document.createElement('button'), { textContent: 'Mark collected' });
      button.onclick = () => run(() => command('/collect/' + encodeURIComponent(ticket.submissionId), 'Ticket #' + ticket.queueNumber + ' collected.'));
      action.append(button);
    }
  }
  byId('empty').hidden = data.rows.length > 0;
  byId('first').hidden = !(cursors.queued || cursors.ready);
  for (const key of ['queued', 'ready']) byId(key).hidden = data.next[key] === null;
}

async function command(path, message) {
  const headers = { 'content-type': 'application/json', 'x-natcut-control': capability };
  if (path === '/start') headers['x-natcut-submission'] = snapshot.claimedSubmissionId;
  await read(path, { method: 'POST', headers });
  await refresh();
  byId('message').textContent = message;
}

byId('claim').onclick = () => run(() => command('/claim', 'Ticket claimed.'));
byId('start').onclick = () => run(() => command('/start', 'Simulation started.'));
byId('refresh').onclick = () => run(refresh);
byId('first').onclick = () => run(async () => { cursors.queued = cursors.ready = 0; await refresh(); });
for (const key of ['queued', 'ready']) {
  byId(key).onclick = () => run(async () => { cursors[key] = snapshot.next[key]; await refresh(); });
}
run(refresh);
