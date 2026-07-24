import { lazy, Suspense, useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// CommonMark 的粗體/斜體 flanking 規則在 CJK 全形標點相鄰時會失效
// （典型：`**標題：**內文`、`文字**「重點」**`），** 會被當一般字元
// 原樣顯示。這個插件依 CJK 友善規則修正解析，星號不再殘留。
import remarkCjkFriendly from 'remark-cjk-friendly';
import clsx from 'clsx';
import { Copy, Edit2, Check, BarChart3, LineChart, PieChart } from 'lucide-react';
import assistantAvatar from '../assets/img/ikea-assistant.webp';
import { normalizeInlineDisplayMath } from '../utils/mathText';

// remark-math/rehype-katex/katex 一起打包大約 250KB+（KaTeX 本體 + 字型），
// 但大多數回答完全沒有數學公式——不該讓每個使用者都下載這包只為了聊天。
// 動態 import 讓 Vite 把這幾個套件拆進獨立 chunk，只有訊息內容真的出現
// `$`（可能是公式）時才觸發下載；一旦下載過，同一頁後續訊息共用同一個
// cached promise，不會重複載入。
let mathPluginsPromise = null;
function loadMathPlugins() {
    if (!mathPluginsPromise) {
        mathPluginsPromise = Promise.all([
            import('remark-math'),
            import('rehype-katex'),
            import('katex/dist/katex.min.css'),
        ]).then(([remarkMathModule, rehypeKatexModule]) => ({
            remarkMath: remarkMathModule.default,
            rehypeKatex: rehypeKatexModule.default,
        }));
    }
    return mathPluginsPromise;
}

const MATH_HINT_RE = /\$/;

// 載入前先用一個字元的規則判斷「這則訊息可能含公式嗎」，避免完全沒有 `$`
// 的訊息也觸發下載。載入完成前，公式會先以原始 $$...$$ 文字顯示，套件到位
// 後這則訊息（以及同一頁其他有公式的訊息）會立刻重新渲染成排版好的公式。
function useMathPlugins(content) {
    const [plugins, setPlugins] = useState(null);
    useEffect(() => {
        if (plugins || !MATH_HINT_RE.test(content)) return;
        let cancelled = false;
        loadMathPlugins().then((loaded) => {
            if (!cancelled) setPlugins(loaded);
        });
        return () => { cancelled = true; };
    }, [content, plugins]);
    return plugins;
}

// ── Preprocess message content ───────────────────────────
// 處理 LLM 三種常見的錯誤 code block 格式，統一轉為合法的 Markdown fenced block
const CODE_LANG_RE = /^(sql|python|javascript|js|typescript|ts|bash|sh|json|yaml|html|css|chart)[ \t]*/i;
const LazyCodeHighlighter = lazy(() => import('./CodeHighlighter').then(module => ({ default: module.CodeHighlighter })));

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
                // 若無語言標籤且內容含中文或 Markdown 粗體，代表 LLM 誤將敘述文字包在 code block 中
                // 直接輸出為純 Markdown，不要渲染成 code block
                if (!lang && /[一-鿿]|\*\*/.test(rawCode)) {
                    result = ensureNewline(result);
                    result += rawCode + '\n';
                    i = closingIdx + 3;
                } else {
                    result = ensureNewline(result);
                    result += `\`\`\`${lang}\n${rawCode}\n\`\`\`\n`;
                    i = closingIdx + 3;
                }
            } else {
                // 沒有結尾 ```（LLM 忘記加）：
                // 取到段落結束（雙換行）或字串結尾
                const paraEnd = content.indexOf('\n\n', codeStart);
                const rawCode = paraEnd !== -1
                    ? content.slice(codeStart, paraEnd).trim()
                    : content.slice(codeStart).trim();

                if (!lang && /[一-鿿]|\*\*/.test(rawCode)) {
                    result = ensureNewline(result);
                    result += rawCode + '\n';
                    i = paraEnd !== -1 ? paraEnd : len;
                } else {
                    result = ensureNewline(result);
                    result += `\`\`\`${lang}\n${rawCode}\n\`\`\`\n`;
                    i = paraEnd !== -1 ? paraEnd : len;
                }
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
            <Suspense fallback={<pre className="code-loading"><code>{code}</code></pre>}>
                <LazyCodeHighlighter language={language || 'text'} code={code} />
            </Suspense>
        </div>
    );
}

function parseChartSpec(code) {
    try {
        const spec = JSON.parse(code);
        const validType = ['bar', 'line', 'pie'].includes(spec.type) ? spec.type : 'bar';
        const base = {
            title: spec.title || 'Chart',
            type: validType,
            xKey: spec.xKey || 'label',
            yKey: spec.yKey || 'value',
            isSequential: spec.isSequential === true,
        };

        // Internal format: { data: [{ label, value }] }
        if (Array.isArray(spec.data) && spec.data.length > 0 && typeof spec.data[0] === 'object') {
            const data = spec.data
                .map(item => ({
                    label: String(item[spec.xKey || 'label'] ?? item.label ?? ''),
                    value: Number(item[spec.yKey || 'value'] ?? item.value ?? 0),
                }))
                .filter(item => item.label && Number.isFinite(item.value));
            if (data.length > 0) return { ...base, data };
        }

        // Chart.js-style: { labels: [...], datasets: [{ data: [...] }] }
        //              or: { labels: [...], values: [...] }
        //              or: { labels: [...], data: [10, 8, 3] }
        if (Array.isArray(spec.labels) && spec.labels.length > 0) {
            let rawValues = [];
            if (Array.isArray(spec.datasets) && spec.datasets.length > 0 && Array.isArray(spec.datasets[0].data)) {
                rawValues = spec.datasets[0].data;
            } else if (Array.isArray(spec.values)) {
                rawValues = spec.values;
            } else if (Array.isArray(spec.data) && spec.data.every(d => typeof d === 'number')) {
                rawValues = spec.data;
            }
            if (rawValues.length > 0) {
                const data = spec.labels
                    .map((label, i) => ({ label: String(label), value: Number(rawValues[i] ?? 0) }))
                    .filter(item => item.label && Number.isFinite(item.value));
                if (data.length > 0) return { ...base, xKey: 'label', yKey: 'value', data };
            }
        }

        return null;
    } catch {
        return null;
    }
}

function InteractiveChart({ code }) {
    const spec = parseChartSpec(code);
    // Sequential (time-series) data: bar + line only, single color
    // Categorical data: bar + pie (if ≤8 items), palette colors
    const isSequential = spec?.isSequential === true;
    const allowedTypes = !spec || spec.data.length === 0
        ? ['bar']
        : isSequential
        ? ['bar', 'line']
        : spec.data.length <= 8 ? ['bar', 'pie'] : ['bar'];
    const defaultType = spec && allowedTypes.includes(spec.type) ? spec.type : allowedTypes[0];
    const [activeType, setActiveType] = useState(defaultType);
    const [hovered, setHovered] = useState(null);

    if (!spec || spec.data.length === 0) {
        return <CodeBlock language="json" code={code} />;
    }

    const selectedType = allowedTypes.includes(activeType) ? activeType : defaultType;

    const width = 720;
    const height = 300;
    const padding = { top: 18, right: 24, bottom: 58, left: 54 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(...spec.data.map(d => d.value), 1);
    const total = spec.data.reduce((sum, d) => sum + d.value, 0);
    const palette = ['#0058A3', '#FFDB00', '#0A8A73', '#E94D2A', '#6F5BD6', '#767676', '#CA5008', '#2E7D32'];
    const seqColor = '#0058A3';

    const renderBarChart = () => {
        const gap = 10;
        const barWidth = Math.max(18, (chartWidth - gap * (spec.data.length - 1)) / spec.data.length);
        return (
            <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={spec.title}>
                <line x1={padding.left} y1={padding.top + chartHeight} x2={width - padding.right} y2={padding.top + chartHeight} className="chart-axis" />
                <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + chartHeight} className="chart-axis" />
                {spec.data.map((item, idx) => {
                    const barHeight = (item.value / maxValue) * chartHeight;
                    const x = padding.left + idx * (barWidth + gap);
                    const y = padding.top + chartHeight - barHeight;
                    const fill = isSequential ? seqColor : palette[idx % palette.length];
                    const anchor = { ...item, x: x + barWidth / 2, y };
                    return (
                        <g key={item.label} onMouseEnter={() => setHovered(anchor)} onMouseLeave={() => setHovered(null)}>
                            <rect x={x} y={y} width={barWidth} height={barHeight} rx="3" fill={fill} className="chart-bar" />
                            <text x={x + barWidth / 2} y={y - 6} textAnchor="middle" className="chart-value">{item.value}</text>
                            <text x={x + barWidth / 2} y={padding.top + chartHeight + 18} textAnchor="middle" className="chart-label">
                                {item.label.length > 10 ? `${item.label.slice(0, 10)}…` : item.label}
                            </text>
                        </g>
                    );
                })}
            </svg>
        );
    };

    const renderLineChart = () => {
        const points = spec.data.map((item, idx) => {
            const x = padding.left + (spec.data.length === 1 ? chartWidth / 2 : (idx / (spec.data.length - 1)) * chartWidth);
            const y = padding.top + chartHeight - (item.value / maxValue) * chartHeight;
            return { ...item, x, y };
        });
        const path = points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
        return (
            <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={spec.title}>
                <line x1={padding.left} y1={padding.top + chartHeight} x2={width - padding.right} y2={padding.top + chartHeight} className="chart-axis" />
                <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + chartHeight} className="chart-axis" />
                <path d={path} className="chart-line" />
                {points.map((point) => (
                    <g key={point.label} onMouseEnter={() => setHovered(point)} onMouseLeave={() => setHovered(null)}>
                        <circle cx={point.x} cy={point.y} r="5" className="chart-dot" />
                        <text x={point.x} y={padding.top + chartHeight + 18} textAnchor="middle" className="chart-label">
                            {point.label.length > 10 ? `${point.label.slice(0, 10)}…` : point.label}
                        </text>
                    </g>
                ))}
            </svg>
        );
    };

    const renderPieChart = () => {
        let angle = -90;
        const cx = width / 2;
        const cy = 145;
        const radius = 96;
        const describeArc = (startAngle, endAngle, r) => {
            const start = {
                x: cx + r * Math.cos((Math.PI / 180) * startAngle),
                y: cy + r * Math.sin((Math.PI / 180) * startAngle),
            };
            const end = {
                x: cx + r * Math.cos((Math.PI / 180) * endAngle),
                y: cy + r * Math.sin((Math.PI / 180) * endAngle),
            };
            const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
            return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y} Z`;
        };

        return (
            <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg chart-pie-svg" role="img" aria-label={spec.title}>
                {spec.data.map((item, idx) => {
                    const slice = total > 0 ? (item.value / total) * 360 : 0;
                    const midAngle = angle + slice / 2;
                    const anchor = {
                        ...item,
                        x: cx + radius * 0.65 * Math.cos((Math.PI / 180) * midAngle),
                        y: cy + radius * 0.65 * Math.sin((Math.PI / 180) * midAngle),
                    };
                    const path = describeArc(angle, angle + slice, radius);
                    angle += slice;
                    return (
                        <path
                            key={item.label}
                            d={path}
                            fill={palette[idx % palette.length]}
                            className="chart-slice"
                            onMouseEnter={() => setHovered(anchor)}
                            onMouseLeave={() => setHovered(null)}
                        />
                    );
                })}
                <text x={cx} y={cy} textAnchor="middle" className="chart-total">{total}</text>
                <text x={cx} y={cy + 20} textAnchor="middle" className="chart-label">total</text>
            </svg>
        );
    };

    return (
        <div className="chart-card">
            <div className="chart-header">
                <div>
                    <p className="chart-title">{spec.title}</p>
                    <p className="chart-subtitle">{spec.data.length} categories · total {total}</p>
                </div>
                <div className="chart-controls" aria-label="Chart type">
                    {allowedTypes.includes('bar') && <button type="button" className={selectedType === 'bar' ? 'active' : ''} onClick={() => setActiveType('bar')} title="Bar chart"><BarChart3 size={16} /></button>}
                    {allowedTypes.includes('line') && <button type="button" className={selectedType === 'line' ? 'active' : ''} onClick={() => setActiveType('line')} title="Line chart"><LineChart size={16} /></button>}
                    {allowedTypes.includes('pie') && <button type="button" className={selectedType === 'pie' ? 'active' : ''} onClick={() => setActiveType('pie')} title="Pie chart"><PieChart size={16} /></button>}
                </div>
            </div>
            <div className="chart-body">
                <div className="chart-plot">
                    <div className="chart-scroll-x">
                        {selectedType === 'bar' && renderBarChart()}
                        {selectedType === 'line' && renderLineChart()}
                        {selectedType === 'pie' && renderPieChart()}
                    </div>
                    {hovered && (
                        <div
                            className="chart-tooltip"
                            style={{
                                left: `${Math.min(94, Math.max(6, (hovered.x / width) * 100))}%`,
                                top: `${(hovered.y / height) * 100}%`,
                            }}
                        >
                            <strong>{hovered.label}</strong>
                            <span>{hovered.value}</span>
                        </div>
                    )}
                </div>
            </div>
            {!isSequential && (
                <div className="chart-legend">
                    {spec.data.map((item, idx) => (
                        <span key={item.label}><i style={{ backgroundColor: palette[idx % palette.length] }} />{item.label}</span>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Markdown components override ──────────────────────────
const markdownComponents = {
    a: (props) => {
        const anchorProps = { ...props };
        delete anchorProps.node;
        return <a {...anchorProps} target="_blank" rel="noopener noreferrer" />;
    },
    table: (props) => {
        const tableProps = { ...props };
        delete tableProps.node;
        return (
            <div className="markdown-table-scroll">
                <table {...tableProps} />
            </div>
        );
    },
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

        if (language === 'chart') {
            return <InteractiveChart code={code} />;
        }

        // LLM sometimes mislabels chart specs as json — auto-detect and render as chart
        if (language === 'json') {
            try {
                const raw = JSON.parse(code);
                if (
                    raw &&
                    ['bar', 'line', 'pie'].includes(raw.type) &&
                    Array.isArray(raw.data) &&
                    'title' in raw
                ) {
                    return <InteractiveChart code={code} />;
                }
            } catch {
                // not JSON — fall through to CodeBlock
            }
        }

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

function formatElapsed(ms) {
    if (!Number.isFinite(Number(ms))) return 'n/a';
    if (Number(ms) < 1000) return `${Math.round(Number(ms))} ms`;
    return `${(Number(ms) / 1000).toFixed(1)}s`;
}

function formatTokenUsage(usage = {}) {
    const total = usage.total_tokens;
    if (!Number.isFinite(Number(total)) || Number(total) <= 0) return 'Not returned by model';
    const input = Number(usage.input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    return `${total} total (${input} in / ${output} out)`;
}

function AssistantDebugPanel({ metadata = {}, errorCode }) {
    const turnContext = metadata.turn_context || {};
    const toolResults = Array.isArray(metadata.tool_results) ? metadata.tool_results : [];
    const hasMetadata = Object.keys(metadata || {}).length > 0 || errorCode;

    if (!hasMetadata) return null;

    return (
        <div className="message-debug-panel">
            <div className="message-debug-grid">
                <span>mode</span>
                <strong>{metadata.mode || (errorCode ? 'error' : 'unknown')}</strong>
                <span>elapsed</span>
                <strong>{formatElapsed(metadata.elapsed_ms)}</strong>
                <span>tokens</span>
                <strong>{formatTokenUsage(metadata.usage)}</strong>
                <span>relation</span>
                <strong>{turnContext.relation || 'standalone'}</strong>
                <span>domain</span>
                <strong>{turnContext.domain_hint || 'none'}</strong>
                <span>tools</span>
                <strong>{toolResults.length > 0 ? toolResults.map(item => item.name || 'tool').join(', ') : 'none'}</strong>
            </div>
            {turnContext.reason && (
                <p className="message-debug-reason">{turnContext.reason}</p>
            )}
            {errorCode && (
                <p className="message-debug-reason">error_code: {errorCode}</p>
            )}
        </div>
    );
}

// ── ChatMessage ───────────────────────────────────────────
export function ChatMessage({ message, userAvatar, debugMode = false, onUpdate, onCopy }) {
    const isUser = message.role === 'user';
    const avatar = isUser ? userAvatar : assistantAvatar;
    const [copied, setCopied] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content);
    const mathPlugins = useMathPlugins(message.content);

    const handleCopy = () => {
        onCopy(message.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleSave = () => {
        onUpdate(editContent);
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
                                remarkPlugins={mathPlugins ? [remarkGfm, remarkCjkFriendly, mathPlugins.remarkMath] : [remarkGfm, remarkCjkFriendly]}
                                rehypePlugins={mathPlugins ? [mathPlugins.rehypeKatex] : []}
                                components={markdownComponents}
                            >
                                {preprocessContent(normalizeInlineDisplayMath(message.content))}
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

                {/* Actions for Assistant Messages */}
                {!isUser && (
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity px-1">
                        <button
                            onClick={handleCopy}
                            className="p-1 text-[#767676] hover:text-[#111111] hover:bg-[#F5F5F5] rounded transition-colors"
                            title="Copy response"
                        >
                            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                        </button>
                    </div>
                )}

                {!isUser && debugMode && (
                    <AssistantDebugPanel metadata={message.metadata} errorCode={message.errorCode} />
                )}
            </div>
        </div>
    );
}
