// remark-math 的 block math 語法要求開/關 $$ 各自獨占一行（像 code fence
// 一樣：$$ 開頭那行、公式內容、$$ 結尾那行，三行分開）。LLM 幾乎都是把整條
// 公式擠在同一行寫成 $$公式$$（不管是獨立成段還是混在句子/條列項目中），
// 這種單行寫法不符合 block math 語法，remark-math 只會把它當成「行內」
// math 解析（用雙錢字號當 inline 分隔符）。這會導致 KaTeX 用 textstyle
// （非 displayMode）渲染，不會套用 .katex-display 該有的上下留白，公式一長
// 就會跟前後文字擠在一起、視覺上重疊。
// 這裡依「是否獨占一行」分流：獨占一行（前後只有空白）→ 補成三行的合法
// block math 語法，讓 KaTeX 用 displayMode 渲染、保留該有的留白；混在句子
// 或條列項目中間 → 改寫成單一 $...$（合法的 inline math），維持行內大小。
export function normalizeInlineDisplayMath(content) {
    return content.replace(/\$\$([\s\S]+?)\$\$/g, (match, inner, offset) => {
        const before = content.slice(0, offset);
        const after = content.slice(offset + match.length);
        const linePrefix = before.slice(before.lastIndexOf('\n') + 1);
        const nextNewline = after.indexOf('\n');
        const lineSuffix = nextNewline === -1 ? after : after.slice(0, nextNewline);
        const trimmedInner = inner.trim();
        if (!trimmedInner) return match;
        if (linePrefix.trim() === '' && lineSuffix.trim() === '') {
            return `$$\n${trimmedInner}\n$$`;
        }
        return `$${trimmedInner}$`;
    });
}
