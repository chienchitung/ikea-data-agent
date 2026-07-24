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

export async function listActionItems() {
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readonly');
    const items = await promisifyRequest(tx.objectStore(ACTION_ITEMS_STORE).getAll());
    return items.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

export async function hasImportedActionsForMeeting(meetingId) {
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readonly');
    const index = tx.objectStore(ACTION_ITEMS_STORE).index('by_meeting_id');
    const existing = await promisifyRequest(index.getAll(meetingId));
    return existing.length > 0;
}

// Imports every row in meetingRecord.meeting_data.actions_review as a new
// "To Do" card. Callers are expected to check hasImportedActionsForMeeting()
// first and skip the call entirely if it's already true — this function
// itself does not dedupe, so calling it twice for the same meeting creates
// duplicate cards.
export async function importActionItemsFromMeeting(meetingRecord) {
    const actions = meetingRecord?.meeting_data?.actions_review;
    if (!Array.isArray(actions) || actions.length === 0) return [];

    const meetingId = meetingRecord.meeting_id;
    const meetingTitle = meetingRecord.meeting_data?.meeting_title || 'Meeting Notes';
    const now = new Date().toISOString();

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
    const now = new Date().toISOString();
    const record = {
        id: generateId(),
        meeting_id: null,
        meeting_title: '',
        item: trimmed,
        assigned_to: String(assignedTo || '').trim(),
        deadline: String(deadline || '').trim(),
        status: ACTION_STATUSES.includes(status) ? status : 'To Do',
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

// Convenience wrapper around updateActionItem for the drag-and-drop board —
// dropping a card in a new column is just a status change.
export async function moveActionItem(id, status) {
    if (!ACTION_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    return updateActionItem(id, { status });
}

export async function deleteActionItem(id) {
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
    tx.objectStore(ACTION_ITEMS_STORE).delete(id);
    await promisifyTransaction(tx);
}
