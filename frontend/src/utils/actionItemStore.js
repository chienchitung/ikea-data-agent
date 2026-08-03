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
import { getMeetingRecord, updateMeetingRecordData } from './meetingStore';

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

// Syncs meetingRecord.meeting_data.actions_review onto the Action Items
// board — safe to call repeatedly (re-clicking "Sync" doesn't duplicate
// cards) and self-healing after cards are deleted from the board. This is
// the meeting-\>board half of a two-way link; updateActionItem() below is
// the board-\>meeting half (editing a linked card writes item/assigned_to/
// deadline back onto its source actions_review row). Both directions key
// off the same stable id, so either side can be the one that's out of date
// and still end up correct after the other side acts.
//
// Each actions_review row is matched to a board card via a stable "id" on
// the row (set by the backend when minutes are generated — see
// _normalize_actions in meeting.py), not by matching text, so renaming a
// card's content doesn't break the link. Rows from older meeting records
// that predate this field get one assigned here on first sync, persisted
// back to the record so the same row keeps the same id on every future
// sync.
//
//   - Row has a linked card already on the board -> that card's item/
//     assigned_to/deadline/meeting_title are overwritten with the meeting
//     record's current values. status and order are left untouched, so
//     board position/progress survives a sync.
//   - Row has no linked card (new row, or its card was deleted) -> a new
//     "To Do" card is created, appended after whatever's already in that
//     column.
//   - Cards on the board whose source row no longer exists in
//     actions_review are left alone (not deleted) — sync only pushes
//     forward, it never removes something the user might still want to
//     track on the board.
//
// Known gap: cards imported before this field existed have no
// source_action_id and won't be recognized on their first post-upgrade
// sync, so that one sync can create a duplicate for each of them — a
// one-time transition cost, not an ongoing issue once every card has a
// linked id.
export async function syncActionItemsFromMeeting(meetingRecord) {
    const actions = meetingRecord?.meeting_data?.actions_review;
    if (!Array.isArray(actions) || actions.length === 0) {
        return { created: 0, updated: 0, record: meetingRecord };
    }

    const meetingId = meetingRecord.meeting_id;
    const meetingTitle = meetingRecord.meeting_data?.meeting_title || 'Meeting Notes';

    let idsChanged = false;
    const actionsWithIds = actions.map((action) => {
        if (action && !action.id) {
            idsChanged = true;
            return { ...action, id: generateId() };
        }
        return action;
    });

    let record = meetingRecord;
    if (idsChanged) {
        const updatedData = { ...meetingRecord.meeting_data, actions_review: actionsWithIds };
        record = await updateMeetingRecordData(meetingId, updatedData);
    }

    const existing = await getAllRaw();
    const existingByActionId = new Map(
        existing
            .filter((card) => card.meeting_id === meetingId && card.source_action_id)
            .map((card) => [card.source_action_id, card])
    );
    let order = await nextOrderForStatus('To Do', existing);

    const now = new Date().toISOString();
    const toWrite = [];
    let created = 0;
    let updated = 0;

    actionsWithIds
        .filter((action) => action && String(action.item || '').trim())
        .forEach((action) => {
            const existingCard = existingByActionId.get(action.id);
            if (existingCard) {
                updated++;
                toWrite.push({
                    ...existingCard,
                    item: String(action.item || '').trim(),
                    assigned_to: String(action.assigned_to || '').trim(),
                    deadline: String(action.deadline || '').trim(),
                    meeting_title: meetingTitle,
                    updated_at: now,
                });
            } else {
                created++;
                toWrite.push({
                    id: generateId(),
                    source_action_id: action.id,
                    meeting_id: meetingId,
                    meeting_title: meetingTitle,
                    item: String(action.item || '').trim(),
                    assigned_to: String(action.assigned_to || '').trim(),
                    deadline: String(action.deadline || '').trim(),
                    status: 'To Do',
                    order: order++,
                    created_at: now,
                    updated_at: now,
                });
            }
        });

    if (toWrite.length > 0) {
        const db = await openDb();
        const tx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
        const store = tx.objectStore(ACTION_ITEMS_STORE);
        toWrite.forEach((item) => store.put(item));
        await promisifyTransaction(tx);
    }

    return { created, updated, record };
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

const ACTION_CONTENT_FIELDS = ['item', 'assigned_to', 'deadline'];

// The other half of syncActionItemsFromMeeting's meeting-\>board push: a
// card created from a meeting row carries meeting_id + source_action_id
// (see syncActionItemsFromMeeting), which is enough to find its way back to
// that exact actions_review row regardless of what its text has since
// become — same stable-id matching, just walked in the other direction.
// Board-only fields (status, order) intentionally never propagate: a
// meeting's agenda has no "column" concept, so a drag-and-drop move has
// nothing to write back.
async function propagateCardEditToMeeting(card) {
    if (!card.meeting_id || !card.source_action_id) return;
    const record = await getMeetingRecord(card.meeting_id);
    if (!record) return; // the meeting record no longer exists — nothing to sync to
    const actions = record.meeting_data?.actions_review;
    if (!Array.isArray(actions)) return;
    const index = actions.findIndex((a) => a?.id === card.source_action_id);
    if (index === -1) return; // that row was removed from the meeting record; leave the card as-is

    const patchedActions = actions.map((action, i) => (i === index ? {
        ...action,
        item: card.item,
        assigned_to: card.assigned_to,
        deadline: card.deadline,
    } : action));
    await updateMeetingRecordData(card.meeting_id, { ...record.meeting_data, actions_review: patchedActions });
}

export async function updateActionItem(id, patch) {
    const existing = await getActionItem(id);
    if (!existing) throw new Error('Action item not found.');
    const updated = { ...existing, ...patch, id: existing.id, updated_at: new Date().toISOString() };
    const db = await openDb();
    const tx = db.transaction(ACTION_ITEMS_STORE, 'readwrite');
    tx.objectStore(ACTION_ITEMS_STORE).put(updated);
    await promisifyTransaction(tx);

    if (ACTION_CONTENT_FIELDS.some((key) => key in patch)) {
        await propagateCardEditToMeeting(updated);
    }
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
