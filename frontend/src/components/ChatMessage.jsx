import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import clsx from 'clsx';
import { Copy, Edit2, Check } from 'lucide-react';
import assistantAvatar from '../assets/img/ikea-assistant.png';

// ── Preprocess message content ───────────────────────────
// 處理 LLM 三種常見的錯誤 code block 格式，統一轉為合法的 Markdown fenced block
const CODE_LANG_RE = /^(sql|python|javascript|js|typescript|ts|bash|sh|json|yaml|html|css)[ \t]*/i;
const sqlEditorTheme = {
    ...vscDarkPlus,
    'pre[class*="language-"]': {
        ...vscDarkPlus['pre[class*="language-"]'],
        color: '#C9D1D9',
        background: '#252A32',
    },
    'code[class*="language-"]': {
        ...vscDarkPlus['code[class*="language-"]'],
        color: '#C9D1D9',
        background: '#252A32',
    },
    comment: { color: '#7D8590', fontStyle: 'italic' },
    prolog: { color: '#7D8590', fontStyle: 'italic' },
    keyword: { color: '#D783FF' },
    'keyword.control-flow': { color: '#D783FF' },
    function: { color: '#59B8FF' },
    builtin: { color: '#59B8FF' },
    string: { color: '#98C379' },
    char: { color: '#98C379' },
    number: { color: '#F6B26B' },
    boolean: { color: '#F6B26B' },
    operator: { color: '#66D9EF' },
    punctuation: { color: '#C9D1D9' },
    property: { color: '#C9D1D9' },
    variable: { color: '#C9D1D9' },
    constant: { color: '#F6B26B' },
};

// 在 result 末尾確保有換行（Markdown fenced block 必須在行首）
function ensureNewline(s) {
    return s.length > 0 && s[s.length - 1] !== '\n' ? s + '\n' : s;
}

// 收集 code 內容，同時跳過 BigQuery 反引號識別符（`project.dataset.table`）
function collectCode(content, start, len) {
    let code = '';
    let i = start;
    while (i < len) {
        if (content[i] === '`') {
            // 看看接下來是不是 BigQuery 識別符（含點、不含空白）
            let k = i + 1;
            let inner = '';
            while (k < len && content[k] !== '`' && content[k] !== '\n') {
                inner += content[k];
                k++;
            }
            if (k < len && content[k] === '`' && inner.includes('.') && !inner.includes(' ')) {
                // BigQuery 識別符：保留並繼續
                code += '`' + inner + '`';
                i = k + 1;
            } else {
                // 單反引號結束符：停止收集
                i++;
                break;
            }
        } else {
            code += content[i];
            i++;
        }
    }
    return { code, end: i };
}

function preprocessContent(content) {
    let result = '';
    let i = 0;
    const len = content.length;

    while (i < len) {

        // ── 情況 A：遇到三反引號 ──────────────────────────────
        if (content[i] === '`' && content[i + 1] === '`' && content[i + 2] === '`') {
            // 提取語言標籤（如果有）
            const afterOpen = content.slice(i + 3);
            const langMatch = afterOpen.match(CODE_LANG_RE);
            const lang = langMatch ? langMatch[1].toLowerCase() : '';
            const codeStart = i + 3 + (langMatch ? langMatch[0].length : 0);

            // 找結尾的 ```（必須單獨在一行，或直接跟在內容後面）
            const closingIdx = content.indexOf('```', codeStart);

            if (closingIdx !== -1) {
                // 有結尾 ```：格式正確或可修復
                const rawCode = content.slice(codeStart, closingIdx).trim();
                result = ensureNewline(result);
                result += `\`\`\`${lang}\n${rawCode}\n\`\`\`\n`;
                i = closingIdx + 3;
            } else {
                // 沒有結尾 ```（LLM 忘記加）：
                // 取到段落結束（雙換行）或字串結尾
                const paraEnd = content.indexOf('\n\n', codeStart);
                const rawCode = paraEnd !== -1
                    ? content.slice(codeStart, paraEnd).trim()
                    : content.slice(codeStart).trim();

                result = ensureNewline(result);
                result += `\`\`\`${lang}\n${rawCode}\n\`\`\`\n`;
                i = paraEnd !== -1 ? paraEnd : len;
            }
            continue;
        }

        // ── 情況 B：遇到單反引號 + 語言標籤（`sql ...`） ──────
        if (content[i] === '`') {
            const rest = content.slice(i + 1);
            const langMatch = rest.match(CODE_LANG_RE);

            if (langMatch) {
                const lang = langMatch[1].toLowerCase();
                const codeStart = i + 1 + langMatch[0].length;
                const { code, end } = collectCode(content, codeStart, len);

                result = ensureNewline(result);
                result += `\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`;
                i = end;
                continue;
            }
        }

        result += content[i];
        i++;
    }

    return result;
}

// ── Code Block with copy button ───────────────────────────
function CodeBlock({ language, code }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="my-4 overflow-hidden rounded-lg bg-[#282C34] shadow-sm">
            {/* Header bar */}
            <div className="flex h-10 items-center justify-between bg-[#1F1D2B] px-5">
                <span className="font-mono text-xs uppercase tracking-wide text-[#DFDFDF]">
                    {language || 'code'}
                </span>
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold text-[#DFDFDF] transition-colors hover:bg-[#484848] hover:text-white"
                    aria-label="Copy code"
                >
                    {copied
                        ? <><Check size={13} className="text-green-400" /><span className="text-green-400">Copied</span></>
                        : <><Copy size={13} /><span>Copy</span></>
                    }
                </button>
            </div>
            {/* Code content */}
            <SyntaxHighlighter
                language={language || 'text'}
                style={sqlEditorTheme}
                customStyle={{
                    margin: 0,
                    borderRadius: 0,
                    padding: '20px',
                    fontSize: '13.5px',
                    lineHeight: '1.62',
                    background: '#282c34',
                    maxHeight: '640px',
                    overflow: 'auto',
                    fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace',
                }}
                codeTagProps={{
                    style: {
                        fontFamily: 'inherit',
                    }
                }}
                wrapLongLines={false}
            >
                {code}
            </SyntaxHighlighter>
        </div>
    );
}

// ── Markdown components override ──────────────────────────
const markdownComponents = {
    a: ({ node, ...props }) => (
        <a {...props} target="_blank" rel="noopener noreferrer" />
    ),
    // pre 攔截 block code（react-markdown v10 正確寫法）
    pre({ children }) {
        const child = Array.isArray(children) ? children[0] : children;
        const className = child?.props?.className || '';
        const match = /language-(\w+)/.exec(className);
        const language = match ? match[1] : '';

        // children 可能是 string 或 array（多段文字節點），需要都處理
        const rawChildren = child?.props?.children;
        let code;
        if (Array.isArray(rawChildren)) {
            code = rawChildren
                .map(c => (typeof c === 'string' ? c : ''))
                .join('');
        } else {
            code = String(rawChildren ?? '');
        }
        code = code.replace(/\n$/, '');

        return <CodeBlock language={language} code={code} />;
    },
    // code 只處理 inline（block 已被 pre 攔截）
    code({ children, className }) {
        // 有 language-xxx class 代表是 block code（被 pre 包著），直接 passthrough
        if (className?.startsWith('language-')) {
            return <code className={className}>{children}</code>;
        }
        return (
            <code className="bg-[#F5F5F5] text-[#CA5008] px-1.5 py-0.5 rounded text-[0.85em] font-mono">
                {children}
            </code>
        );
    },
};

// ── ChatMessage ───────────────────────────────────────────
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
                                className="w-full bg-transparent text-white border border-[#484848] rounded p-2 focus:outline-none focus:border-[#CCCCCC] resize-none"
                                rows={Math.max(3, editContent.split('\n').length)}
                                autoFocus
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={handleCancel}
                                    className="px-3 py-1 text-xs bg-[#484848] hover:bg-[#111111] rounded text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="px-3 py-1 text-xs bg-[#0058A3] hover:bg-[#004F93] rounded text-white transition-colors"
                                >
                                    Save & Submit
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="markdown">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={markdownComponents}
                            >
                                {preprocessContent(message.content)}
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
                            className="p-1 text-[#767676] hover:text-[#111111] hover:bg-[#F5F5F5] rounded transition-colors"
                            title="Edit message"
                        >
                            <Edit2 size={14} />
                        </button>
                        <button
                            onClick={handleCopy}
                            className="p-1 text-[#767676] hover:text-[#111111] hover:bg-[#F5F5F5] rounded transition-colors"
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
