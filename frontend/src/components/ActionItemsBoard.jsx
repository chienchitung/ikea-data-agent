import { useState, useEffect, useCallback } from 'react';
import {
    DndContext,
    DragOverlay,
    PointerSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    useDroppable,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, Trash2, Edit2, X, Check, Loader2, FileAudio, User, Calendar } from 'lucide-react';
import {
    listActionItems,
    addActionItem,
    updateActionItem,
    reorderActionItems,
    deleteActionItem,
    ACTION_STATUSES,
} from '../utils/actionItemStore';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// <input type="date"> only accepts an exact YYYY-MM-DD value — anything
// else (e.g. a meeting-generated "3/5") just renders as blank rather than
// throwing, but showing it as blank would make the underlying text look
// lost. Leaving draft.deadline untouched (only overwritten by onChange)
// means an untouched field still saves the original string; the caption
// below the input is just there so that isn't invisible to the user.
function toDateInputValue(value) {
    return ISO_DATE_RE.test(value || '') ? value : '';
}

function Card({ item, isEditing, onStartEdit, onCancelEdit, onSave, onDelete }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
    const [draft, setDraft] = useState(item);

    // Reset the draft right when editing starts (in the click handler, not
    // an effect watching isEditing) — this Card instance stays mounted
    // across edit sessions (keyed by item.id in the column list), so a
    // stale draft from a previous cancelled edit would otherwise resurface.
    const startEditing = () => {
        setDraft(item);
        onStartEdit(item.id);
    };

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    if (isEditing) {
        return (
            <div className="bg-white rounded-lg border border-[#0058A3] p-3 shadow-sm space-y-2">
                <textarea
                    value={draft.item}
                    onChange={(e) => setDraft((d) => ({ ...d, item: e.target.value }))}
                    className="w-full text-sm border border-[#DFDFDF] rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#0058A3] resize-none"
                    rows={2}
                    autoFocus
                />
                <input
                    type="text"
                    value={draft.assigned_to}
                    onChange={(e) => setDraft((d) => ({ ...d, assigned_to: e.target.value }))}
                    placeholder="Assigned to"
                    className="w-full text-xs border border-[#DFDFDF] rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#0058A3]"
                />
                <div>
                    <input
                        type="date"
                        value={toDateInputValue(draft.deadline)}
                        onChange={(e) => setDraft((d) => ({ ...d, deadline: e.target.value }))}
                        className="w-full text-xs border border-[#DFDFDF] rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#0058A3]"
                    />
                    {draft.deadline && !ISO_DATE_RE.test(draft.deadline) && (
                        <p className="text-[10px] text-[#AAAAAA] mt-0.5">Current: {draft.deadline} (pick a date to replace)</p>
                    )}
                </div>
                <div className="flex justify-end gap-1.5">
                    <button
                        type="button"
                        onClick={onCancelEdit}
                        className="p-1.5 hover:bg-[#F5F5F5] rounded transition-colors"
                        aria-label="Cancel edit"
                    >
                        <X className="w-3.5 h-3.5 text-[#767676]" />
                    </button>
                    <button
                        type="button"
                        onClick={() => onSave(draft)}
                        disabled={!draft.item.trim()}
                        className="p-1.5 hover:bg-blue-50 rounded transition-colors disabled:opacity-40"
                        aria-label="Save"
                    >
                        <Check className="w-3.5 h-3.5 text-[#0058A3]" />
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...listeners}
            {...attributes}
            className={`bg-white rounded-lg border border-[#DFDFDF] p-3 shadow-sm cursor-grab active:cursor-grabbing group touch-none ${isDragging ? 'opacity-40' : ''}`}
        >
            <p className="text-sm text-[#111111] leading-snug">{item.item}</p>
            {(item.assigned_to || item.deadline) && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-[#767676]">
                    {item.assigned_to && (
                        <span className="inline-flex items-center gap-1">
                            <User className="w-3 h-3 flex-shrink-0" />
                            {item.assigned_to}
                        </span>
                    )}
                    {item.deadline && (
                        <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3 h-3 flex-shrink-0" />
                            {item.deadline}
                        </span>
                    )}
                </div>
            )}
            {item.meeting_title && (
                <div className="flex items-center gap-1 mt-2 text-[11px] text-[#AAAAAA]">
                    <FileAudio className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{item.meeting_title}</span>
                </div>
            )}
            <div className="flex justify-end gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={startEditing}
                    className="p-1 hover:bg-[#F5F5F5] rounded transition-colors"
                    aria-label="Edit card"
                >
                    <Edit2 className="w-3 h-3 text-[#767676]" />
                </button>
                <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onDelete(item.id)}
                    className="p-1 hover:bg-red-50 rounded transition-colors"
                    aria-label="Delete card"
                >
                    <Trash2 className="w-3 h-3 text-red-500" />
                </button>
            </div>
        </div>
    );
}

function Column({ status, items, editingId, onStartEdit, onCancelEdit, onSave, onDelete, isAdding, onStartAdd, onCancelAdd, onConfirmAdd }) {
    const { setNodeRef, isOver } = useDroppable({ id: status });
    const [draftText, setDraftText] = useState('');
    const itemIds = items.map((i) => i.id);

    const handleConfirmAdd = () => {
        if (!draftText.trim()) return;
        onConfirmAdd(status, draftText.trim());
        setDraftText('');
    };

    return (
        <div className="flex-1 min-w-[260px] max-w-[340px] flex flex-col bg-[#F5F5F5] rounded-xl">
            <div className="flex items-center justify-between px-3 py-2.5 flex-shrink-0">
                <span className="text-xs font-semibold text-[#767676] tracking-wide uppercase">{status}</span>
                <span className="text-xs text-[#AAAAAA]">{items.length}</span>
            </div>
            <div
                ref={setNodeRef}
                className={`flex-1 overflow-y-auto px-2 pb-2 space-y-2 min-h-[120px] rounded-lg transition-colors ${isOver ? 'bg-blue-50' : ''}`}
            >
                <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                    {items.map((item) => (
                        <Card
                            key={item.id}
                            item={item}
                            isEditing={editingId === item.id}
                            onStartEdit={onStartEdit}
                            onCancelEdit={onCancelEdit}
                            onSave={onSave}
                            onDelete={onDelete}
                        />
                    ))}
                </SortableContext>
                {items.length === 0 && !isAdding && (
                    <p className="text-xs text-[#AAAAAA] text-center py-6">No cards</p>
                )}
                {isAdding && (
                    <div className="bg-white rounded-lg border border-[#0058A3] p-2 space-y-2">
                        <textarea
                            value={draftText}
                            onChange={(e) => setDraftText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleConfirmAdd(); }
                                if (e.key === 'Escape') onCancelAdd();
                            }}
                            placeholder="Action item…"
                            className="w-full text-sm border border-[#DFDFDF] rounded px-2 py-1 focus:outline-none resize-none"
                            rows={2}
                            autoFocus
                        />
                        <div className="flex justify-end gap-1.5">
                            <button type="button" onClick={onCancelAdd} className="p-1.5 hover:bg-[#F5F5F5] rounded transition-colors" aria-label="Cancel">
                                <X className="w-3.5 h-3.5 text-[#767676]" />
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmAdd}
                                disabled={!draftText.trim()}
                                className="p-1.5 hover:bg-blue-50 rounded transition-colors disabled:opacity-40"
                                aria-label="Add card"
                            >
                                <Check className="w-3.5 h-3.5 text-[#0058A3]" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {!isAdding && (
                <button
                    type="button"
                    onClick={() => onStartAdd(status)}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#767676] hover:bg-white/60 rounded-b-xl transition-colors flex-shrink-0"
                >
                    <Plus className="w-3.5 h-3.5" /> Add card
                </button>
            )}
        </div>
    );
}

export function ActionItemsBoard() {
    const [items, setItems] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [editingId, setEditingId] = useState(null);
    const [addingStatus, setAddingStatus] = useState(null);
    const [activeItem, setActiveItem] = useState(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor)
    );

    const refresh = useCallback(async () => {
        const loaded = await listActionItems();
        setItems(loaded);
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                await refresh();
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [refresh]);

    // A status name is always a valid drop target id (the column's own
    // droppable, e.g. for dropping into empty space or an empty column);
    // otherwise resolve which column a card id currently belongs to.
    const findStatus = useCallback((id) => {
        if (ACTION_STATUSES.includes(id)) return id;
        return items.find((i) => i.id === id)?.status || null;
    }, [items]);

    const handleDragStart = (event) => {
        const item = items.find((i) => i.id === event.active.id);
        setActiveItem(item || null);
    };

    // Live-updates the dragged card's status as it crosses into a different
    // column, so the columns visually reflect where it would land — final
    // ordering/persistence happens in handleDragEnd once the drag settles.
    const handleDragOver = (event) => {
        const { active, over } = event;
        if (!over) return;
        const activeStatus = findStatus(active.id);
        const overStatus = findStatus(over.id);
        if (!activeStatus || !overStatus || activeStatus === overStatus) return;
        setItems((prev) => prev.map((i) => (i.id === active.id ? { ...i, status: overStatus } : i)));
    };

    const handleDragEnd = async (event) => {
        setActiveItem(null);
        const { active, over } = event;
        if (!over) return;

        const finalStatus = findStatus(over.id);
        if (!finalStatus) return;

        const columnItems = items.filter((i) => i.status === finalStatus);
        const activeIndex = columnItems.findIndex((i) => i.id === active.id);
        const overIndex = columnItems.findIndex((i) => i.id === over.id);
        const reordered = (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex)
            ? arrayMove(columnItems, activeIndex, overIndex)
            : columnItems;

        const orderedIds = reordered.map((i) => i.id);
        const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
        const previousItems = items;

        // Updating each item's `order` field alone isn't enough to move it on
        // screen: Column renders items in `items` array order (via filter),
        // which a plain .map() over the previous array doesn't change. Resort
        // by the new order values so the drop is reflected immediately instead
        // of only after the next full reload.
        setItems((prev) => {
            const next = prev.map((i) => (orderMap.has(i.id) ? { ...i, status: finalStatus, order: orderMap.get(i.id) } : i));
            return next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        });

        try {
            await reorderActionItems(finalStatus, orderedIds);
        } catch (error) {
            console.error('Failed to persist card move:', error);
            setItems(previousItems);
        }
    };

    const handleSaveEdit = async (draft) => {
        setEditingId(null);
        setItems((prev) => prev.map((i) => (i.id === draft.id ? draft : i)));
        try {
            await updateActionItem(draft.id, {
                item: draft.item.trim(),
                assigned_to: draft.assigned_to.trim(),
                deadline: draft.deadline.trim(),
            });
        } catch (error) {
            console.error('Failed to update action item:', error);
            await refresh();
        }
    };

    const handleDelete = async (id) => {
        setItems((prev) => prev.filter((i) => i.id !== id));
        try {
            await deleteActionItem(id);
        } catch (error) {
            console.error('Failed to delete action item:', error);
            await refresh();
        }
    };

    const handleConfirmAdd = async (status, text) => {
        setAddingStatus(null);
        try {
            const created = await addActionItem({ item: text, status });
            setItems((prev) => [...prev, created]);
        } catch (error) {
            console.error('Failed to add action item:', error);
        }
    };

    return (
        <div className="flex-1 overflow-x-auto overflow-y-hidden p-4 sm:p-6 bg-white">
            <div className="max-w-5xl mx-auto mb-4">
                <h1 className="text-xl font-bold text-[#111111]">Action Items</h1>
                <p className="text-sm text-[#767676] mt-0.5">
                    Drag a card to reorder it or move it between columns. Cards tagged with a meeting name were imported from that meeting's minutes.
                </p>
            </div>
            {isLoading ? (
                <div className="flex justify-center py-16">
                    <Loader2 className="w-6 h-6 animate-spin text-[#0058A3]" />
                </div>
            ) : (
                <DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
                    <div className="flex gap-4 max-w-5xl mx-auto h-[calc(100%-4rem)]">
                        {ACTION_STATUSES.map((status) => (
                            <Column
                                key={status}
                                status={status}
                                items={items.filter((i) => i.status === status)}
                                editingId={editingId}
                                onStartEdit={setEditingId}
                                onCancelEdit={() => setEditingId(null)}
                                onSave={handleSaveEdit}
                                onDelete={handleDelete}
                                isAdding={addingStatus === status}
                                onStartAdd={setAddingStatus}
                                onCancelAdd={() => setAddingStatus(null)}
                                onConfirmAdd={handleConfirmAdd}
                            />
                        ))}
                    </div>
                    <DragOverlay>
                        {activeItem ? (
                            <div className="bg-white rounded-lg border border-[#0058A3] p-3 shadow-lg w-[240px]">
                                <p className="text-sm text-[#111111] leading-snug">{activeItem.item}</p>
                            </div>
                        ) : null}
                    </DragOverlay>
                </DndContext>
            )}
        </div>
    );
}
