"""Render validated inline text without accepting executable markup."""
import html
import re

from .crdt import normalize_blocks, validate_marks

COLORS = {'gray': '#787774', 'brown': '#9f6b53', 'orange': '#d9730d', 'yellow': '#b58105',
          'green': '#448361', 'blue': '#337ea9', 'purple': '#9065b0', 'pink': '#c14c8a', 'red': '#d44c47'}
BACKGROUNDS = {'gray': '#f1f1ef', 'brown': '#f4eeee', 'orange': '#fbecdd', 'yellow': '#fbf3db',
               'green': '#edf3ec', 'blue': '#e7f3f8', 'purple': '#f4f0f7', 'pink': '#f9eef3', 'red': '#fdebec'}


def inline_html(block):
    tokens = block.get('rich_text') or [{'text': block.get('text', ''), 'marks': {}}]
    output = []
    for token in tokens:
        marks = validate_marks(token.get('marks', {}))
        content = html.escape(token.get('text', '')).replace('\n', '<br>')
        for mark, tag in [('code', 'code'), ('bold', 'strong'), ('italic', 'em'), ('underline', 'u'), ('strike', 's')]:
            if marks.get(mark): content = f'<{tag}>{content}</{tag}>'
        styles = []
        if marks.get('color') in COLORS: styles.append('color:' + COLORS[marks['color']])
        if marks.get('background') in BACKGROUNDS: styles.append('background-color:' + BACKGROUNDS[marks['background']])
        if styles: content = '<span style="' + ';'.join(styles) + '">' + content + '</span>'
        if marks.get('link'):
            content = '<a rel="noopener noreferrer" href="' + html.escape(marks['link'], quote=True) + '">' + content + '</a>'
        output.append(content)
    return ''.join(output)


def block_depths(blocks):
    parents = {block['id']: block.get('parent_id') for block in blocks}
    depths = {}
    for block in blocks:
        seen, parent, depth = {block['id']}, parents.get(block['id']), 0
        while parent in parents and parent not in seen:
            seen.add(parent)
            depth += 1
            parent = parents[parent]
        depths[block['id']] = min(depth, 20)
    return depths


def blocks_html(blocks):
    blocks = normalize_blocks(blocks)
    depths = block_depths(blocks)
    pieces = []
    for block in blocks:
        kind = block['type']
        tag = {'heading1': 'h1', 'heading2': 'h2', 'heading3': 'h3', 'quote': 'blockquote', 'code': 'pre'}.get(kind, 'p')
        content = inline_html(block)
        if kind == 'divider': content, tag = '', 'hr'
        if kind in {'bullet', 'numbered'}: content = ('• ' if kind == 'bullet' else '1. ') + content
        if kind == 'todo': content = ('☑ ' if block.get('checked') else '☐ ') + content
        style = f' style="margin-left:{depths[block["id"]] * 24}px"' if depths[block['id']] else ''
        pieces.append(f'<{tag}{style}>{content}</{tag}>' if tag != 'hr' else '<hr>')
    return ''.join(pieces)


def inline_markdown(block):
    output = []
    for token in block.get('rich_text') or [{'text': block.get('text', ''), 'marks': {}}]:
        marks = validate_marks(token.get('marks', {}))
        content = token.get('text', '')
        if marks.get('code'):
            longest = max((len(match[0]) for match in re.finditer(r'`+', content)), default=0)
            fence = '`' * (longest + 1)
            content = fence + (' ' if content.startswith('`') else '') + content + (' ' if content.endswith('`') else '') + fence
        else:
            content = re.sub(r'([\\`*_\[\]<>])', r'\\\1', content)
        for mark, delimiter in [('bold', '**'), ('italic', '*'), ('strike', '~~')]:
            if marks.get(mark): content = delimiter + content + delimiter
        if marks.get('underline'): content = '<u>' + content + '</u>'
        if marks.get('link'):
            destination = marks['link'].replace('(', '%28').replace(')', '%29').replace('<', '%3C').replace('>', '%3E')
            content = '[' + content + '](' + destination + ')'
        output.append(content)
    return ''.join(output)
