// remark-math 只要在文字裡看到任兩個 "$" 字元就會把中間內容當成 inline
// math 解析，不管寫這兩個 "$" 的人是不是真的想寫公式。EC 銷售這類分析報告
// 常常一段話裡出現兩筆金額，例如「Web Sales $2,891,368 / App Sales
// $1,619,091」，remark-math 會把第一個 "$" 到第二個 "$" 之間的「2,891,368 /
// App Sales」整段吃掉當成公式，用 KaTeX 的斜體數學字型渲染，看起來像壞掉的
// 公式（使用者回報的「圖一」問題）。
// 這裡的邏輯：這個 App 裡真正的公式一律是從 $$...$$（雙錢字號）開始的——
// 所以先把每一段 $$...$$ 保護起來（暫時抽換成佔位符，避免被下一步誤傷），
// 再把其餘所有殘留的單一 "$" 逐一跳脫成 "\$"（backslash-escape 是
// CommonMark 標準語法，remark-math 與一般文字都會把 "\$" 顯示成純文字
// "$"，不會被當成公式分隔符），最後把保護起來的公式段落還原。
const MATH_SPAN_PLACEHOLDER_PREFIX = 'MATHSPANPLACEHOLDER';

export function escapeStrayDollarSigns(content) {
    const mathSpans = [];
    const placeholderRe = new RegExp(MATH_SPAN_PLACEHOLDER_PREFIX + '(\\d+)ENDPLACEHOLDER', 'g');

    const protectedContent = content.replace(/\$\$([\s\S]+?)\$\$/g, (match) => {
        mathSpans.push(match);
        return MATH_SPAN_PLACEHOLDER_PREFIX + (mathSpans.length - 1) + 'ENDPLACEHOLDER';
    });
    const escaped = protectedContent.replace(/\$/g, '\\$');
    return escaped.replace(placeholderRe, (fullMatch, indexStr) => mathSpans[Number(indexStr)]);
}

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
