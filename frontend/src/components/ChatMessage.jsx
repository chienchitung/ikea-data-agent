import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import clsx from 'clsx';
import { Copy, Edit2, Check } from 'lucide-react';
import assistantAvatar from '../assets/img/ikea-assistant.png';

export function ChatMessage({ message, userAvatar, onUpdate, onCopy }) {
    const isUser = message.role === 'user';
    const avatar = isUser ? userAvatar : assistantAvatar;
    const [copied, setCopied] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content);

    const handleCopy = () => {
        onCopy(message.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleSave = () => {
        if (editContent.trim() !== message.content) {
            onUpdate(editContent);
        }
        setIsEditing(false);
    };

    const handleCancel = () => {
        setEditContent(message.content);
        setIsEditing(false);
    };

    return (
        <div className={clsx("message-container group", isUser ? "user-container" : "bot-container")}>
            <img
                src={avatar}
                alt={isUser ? "User" : "Assistant"}
                className="message-avatar"
            />
            <div className="flex flex-col gap-1 max-w-full min-w-0 flex-1">
                <div className={clsx("message-bubble", isUser ? "user-bubble" : "bot-bubble")}>
                    {isEditing ? (
                        <div className="flex flex-col gap-2 min-w-[300px]">
                            <textarea
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                className="w-full bg-transparent text-white border border-gray-600 rounded p-2 focus:outline-none focus:border-gray-400 resize-none"
                                rows={Math.max(3, editContent.split('\n').length)}
                                autoFocus
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={handleCancel}
                                    className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="px-3 py-1 text-xs bg-[#0058A3] hover:bg-[#004A8F] rounded text-white transition-colors"
                                >
                                    Save & Submit
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="markdown">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
                                }}
                            >
                                {message.content}
                            </ReactMarkdown>
                        </div>
                    )}
                </div>

                {/* Actions for User Messages */}
                {isUser && !isEditing && (
                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity px-1">
                        <button
                            onClick={() => {
                                setEditContent(message.content);
                                setIsEditing(true);
                            }}
                            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                            title="Edit message"
                        >
                            <Edit2 size={14} />
                        </button>
                        <button
                            onClick={handleCopy}
                            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                            title="Copy text"
                        >
                            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
