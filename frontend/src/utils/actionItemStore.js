// Action-items board: action items generated from a meeting's minutes
// (meeting_data.actions_review), imported into a standalone Kanban board
// tracked separately from the meeting itself. Lives in the same IndexedDB
// database as meeting records (see db.js) — it's browser-local for the same
// reason meeting records are: the backend has no persistent disk to keep it
// on (see the comment at the top of meetingStore.js).
//
// Deliberately NOT synced to Trello: Trello in this app is for tracking
// ticket/request work, not meeting action items — this is a separate board
// by design, not a Trello view.

import { openDb, promisifyRequest, promisifyTransaction, ACTION_ITEMS_STORE } from './db';

export const ACTION_STATUSES = ['To Do', 'Doing', 'Done'];

function generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `action-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getAllRaw() {
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readonly');
    return promisifyRequest(tx.objectStore(ACTION_ITEMS_STORE).getAll());
}

// New cards/imports land at the end of their column — order is a plain
// ascending integer per status, not a global one. Gaps left behind when an
// item leaves a column (moved elsewhere, deleted) are harmless since order
// only matters for relative sorting within a single status.
async function nextOrderForStatus(status, itemsHint) {
    const items = itemsHint || (await getAllRaw());
    const inStatus = items.filter((i) => i.status === status);
    if (inStatus.length === 0) return 0;
    return Math.max(...inStatus.map((i) => (Number.isFinite(i.order) ? i.order : 0))) + 1;
}

export async function listActionItems() {
    const items = await getAllRaw();
    return items.sort((a, b) => {
        const orderA = Number.isFinite(a.order) ? a.order : 0;
        const orderB = Number.isFinite(b.order) ? b.order : 0;
        if (orderA !== orderB) return orderA - orderB;
        return (a.created_at || '').localeCompare(b.created_at || '');
    });
}

export async function hasImportedActionsForMeeting(meetingId) {
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readonly');
    const index = tx.objectStore(ACTION_ITEMS_STORE).index('by_meeting_id');
    const existing = await promisifyRequest(index.getAll(meetingId));
    return existing.length > 0;
}

// Imports every row in meetingRecord.meeting_data.actions_review as a new
// "To Do" card, appended in order after whatever's already in that column.
// Callers are expected to check hasImportedActionsForMeeting() first and
// skip the call entirely if it's already true — this function itself does
// not dedupe, so calling it twice for the same meeting creates duplicates.
export async function importActionItemsFromMeeting(meetingRecord) {
    const actions = meetingRecord?.meeting_data?.actions_review;
    if (!Array.isArray(actions) || actions.length === 0) return [];

    const meetingId = meetingRecord.meeting_id;
    const meetingTitle = meetingRecord.meeting_data?.meeting_title || 'Meeting Notes';
    const now = new Date().toISOString();
    const existing = await getAllRaw();
    let order = await nextOrderForStatus('To Do', existing);

    const items = actions
        .filter((action) => action && String(action.item || '').trim())
        .map((action) => ({
            id: generateId(),
            meeting_id: meetingId,
            meeting_title: meetingTitle,
            item: String(action.item || '').trim(),
            assigned_to: String(action.assigned_to || '').trim(),
            deadline: String(action.deadline || '').trim(),
            status: 'To Do',
            order: order++,
            created_at: now,
            updated_at: now,
        }));
    if (items.length === 0) return [];

    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
    const store = tx.objectStore(ACTION_ITEMS_STORE);
    items.forEach((item) => store.put(item));
    await promisifyTransaction(tx);
    return items;
}

export async function addActionItem({ item, assignedTo = '', deadline = '', status = 'To Do' }) {
    const trimmed = String(item || '').trim();
    if (!trimmed) throw new Error('Action item text is required.');
    const normalizedStatus = ACTION_STATUSES.includes(status) ? status : 'To Do';
    const now = new Date().toISOString();
    const record = {
        id: generateId(),
        meeting_id: null,
        meeting_title: '',
        item: trimmed,
        assigned_to: String(assignedTo || '').trim(),
        deadline: String(deadline || '').trim(),
        status: normalizedStatus,
        order: await nextOrderForStatus(normalizedStatus),
        created_at: now,
        updated_at: now,
    };
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
    tx.objectStore(ACTION_ITEMS_STORE).put(record);
    await promisifyTransaction(tx);
    return record;
}

async function getActionItem(id) {
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readonly');
    const item = await promisifyRequest(tx.objectStore(ACTION_ITEMS_STORE).get(id));
    return item || null;
}

export async function updateActionItem(id, patch) {
    const existing = await getActionItem(id);
    if (!existing) throw new Error('Action item not found.');
    const updated = { ...existing, ...patch, id: existing.id, updated_at: new Date().toISOString() };
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
    tx.objectStore(ACTION_ITEMS_STORE).put(updated);
    await promisifyTransaction(tx);
    return updated;
}

// Convenience wrapper around updateActionItem for a cross-column drag with
// no meaningful drop position (e.g. dropping into an empty column) — moves
// straight to the end of the destination status. Dropping at a specific
// position among existing cards goes through reorderActionItems instead.
export async function moveActionItem(id, status) {
    if (!ACTION_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    const order = await nextOrderForStatus(status);
    return updateActionItem(id, { status, order });
}

// Persists a drag-and-drop result: orderedIds is the full, final ordering
// of cards in `status` after the drop (whether that was a same-column
// reorder or a card arriving from a different column). Each item's order
// becomes its index in that list; status is set on all of them too, since
// the moved card may not have belonged to this column before the drop.
// Items the dragged card left behind in its old column keep their existing
// order values — order is only meaningful as a within-column ranking, so
// the gap left behind doesn't need renumbering.
export async function reorderActionItems(status, orderedIds) {
    if (!ACTION_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;

    const db = await openDb();
    const readTx = db.transaction(ACTION_ITEMS_STORE, 'readonly');
    const readStore = readTx.objectStore(ACTION_ITEMS_STORE);
    const items = await Promise.all(orderedIds.map((id) => promisifyRequest(readStore.get(id))));

    const now = new Date().toISOString();
    const writeTx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
    const writeStore = writeTx.objectStore(ACTION_ITEMS_STORE);
    items.forEach((existing, index) => {
        if (!existing) return;
        writeStore.put({ ...existing, status, order: index, updated_at: now });
    });
    await promisifyTransaction(writeTx);
}

export async function deleteActionItem(id) {
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
    tx.objectStore(ACTION_ITEMS_STORE).delete(id);
    await promisifyTransaction(tx);
}
