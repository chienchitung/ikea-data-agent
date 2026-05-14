import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('html', markup);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('yaml', yaml);

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

export function CodeHighlighter({ language, code }) {
    return (
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
    );
}
