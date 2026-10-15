"""Escaped, read-only document publishing and conditional form rendering."""
import html
import json

def render_public(service, path):
    from .advanced import require
    parts = path.strip('/').split('/')
    if len(parts) != 2:
        return None
    if parts[0] == 'sites':
        require(not service.settings().get('disable_public_sharing'), '공개 공유가 비활성화되었습니다', 404)
        sites = [s for s in service.store.list('site') if s.get('slug', s['id']) == parts[1] and s.get('published')]
        require(sites, '게시된 사이트가 없습니다', 404)
        site = sites[0]
        page = service.item('page', site['page_id'])
        require(not page.get('archived'), '삭제된 페이지입니다', 404)
        title = site.get('seo_title') or page['title']
        pieces = []
        for block in page.get('blocks', []):
            tag = {'heading1': 'h1', 'heading2': 'h2', 'heading3': 'h3', 'quote': 'blockquote', 'code': 'pre'}.get(block['type'], 'p')
            pieces.append(f'<{tag}>{html.escape(block.get("text", ""))}</{tag}>')
        content = '<h1>' + html.escape(page['title']) + '</h1>' + ''.join(pieces)
        description = site.get('description', '')
        service.store.audit('site.viewed', {'page_id': page['id'], 'site_id': site['id']})
    else:
        require(not service.settings().get('disable_public_sharing'), '공개 공유가 비활성화되었습니다', 404)
        form = service.item('forms', parts[1])
        require(form.get('published'), '게시된 양식이 없습니다', 404)
        title, description = form['name'], form.get('description', '')
        content = '<h1>' + html.escape(title) + '</h1><p>' + html.escape(description) + '</p>'
        content += '<form id="public-form" data-form-id="' + html.escape(form['id'], quote=True) + '">'
        for field in form['fields']:
            attrs = ' name="' + html.escape(field['id'], quote=True) + '"'
            attrs += ' data-type="' + html.escape(field.get('type', 'text'), quote=True) + '"'
            if field.get('condition'):
                condition = html.escape(json.dumps(field['condition']), quote=True)
                content += '<label data-condition="' + condition + '">'
            else:
                content += '<label>'
            content += html.escape(field.get('label', field['id'])) + (' *' if field.get('required') else '')
            if field.get('required'):
                attrs += ' required'
            if field.get('type') == 'select':
                content += '<select' + attrs + '><option value="">선택</option>' + ''.join('<option>' + html.escape(str(v)) + '</option>' for v in field.get('options', [])) + '</select>'
            else:
                input_type = field.get('type', 'text')
                content += '<input type="' + html.escape(input_type, quote=True) + '"' + attrs + '>'
            content += '</label>'
        content += '<button type="submit">제출</button><p role="status" id="form-status"></p></form><script src="/public.js" defer></script>'
    document = '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + html.escape(title) + '</title><meta name="description" content="' + html.escape(description, quote=True) + '"><style>body{font:16px/1.8 system-ui;color:#37352f;max-width:760px;margin:10vh auto;padding:24px}label{display:block;margin:20px 0}input,select{display:block;padding:10px;font:inherit;width:100%;box-sizing:border-box;border:1px solid #ddd;border-radius:6px}input[type=checkbox]{width:auto}button{padding:10px 30px;background:#2383e2;border:0;color:white;border-radius:6px;font:inherit}pre{white-space:pre-wrap;background:#f5f5f4;padding:20px}blockquote{border-left:3px solid;padding-left:20px}</style><main>' + content + '</main></html>'
    return 200, {'_html': document}

