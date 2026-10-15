"""Paid-plan workflow primitives; external services stay explicit boundaries."""
from __future__ import annotations

import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4

from .core import APIError, AUDIT_ACTOR


class AdvancedError(APIError):
    def __init__(self, message, status=400):
        super().__init__(status, message)


def require(condition, message, status=400):
    if not condition:
        raise AdvancedError(message, status)


def now():
    return datetime.now(timezone.utc).isoformat()


def text(value, name, limit=10000):
    require(isinstance(value, str) and 0 < len(value.strip()) <= limit, f'{name}: 비어 있지 않은 문자열이 필요합니다')
    return value.strip()


FEATURES = [
    ('pages', '블록 문서와 중첩 페이지', 'Plus', 'implemented', '페이지·블록·검색·휴지통·파일'),
    ('history', '페이지 버전 복원', 'Plus', 'implemented', 'SQLite에 저장한 버전 복원; 보존 기한 제한 없음'),
    ('databases', '데이터베이스와 보기', 'Plus', 'implemented', '속성·테이블·보드·달력·차트'),
    ('forms', '사용자 지정 양식과 조건부 질문', 'Business', 'implemented', '조건에 맞는 질문 검증 후 데이터베이스 행 생성'),
    ('automations', '데이터베이스 자동화', 'Plus', 'implemented', '상태 변경·행 생성·명시적 실행; 주기 실행은 서버 작업 필요'),
    ('sites', '사이트 게시와 메타데이터', 'Plus', 'implemented', '게시한 페이지의 공개 HTML; SEO 제목·설명'),
    ('domains', '사용자 지정 도메인', 'Plus', 'configuration', '호스트명 설정; 실제 DNS·TLS는 운영자 설정 필요'),
    ('teamspaces', '비공개 팀스페이스와 그룹', 'Business', 'implemented', '멤버 계정·비공개 공간·그룹 기반 접근 권한'),
    ('permissions', '세분화된 페이지·행 권한', 'Business', 'implemented', '서버에서 페이지·담당 행 권한 적용; 관계·롤업 결과도 제한'),
    ('ai', 'AI 생성·요약·번역·질의', 'Business', 'provider_required', '무료 로컬 모델 또는 호환 API 연동; 모의 응답 없음'),
    ('meeting', 'AI 회의록', 'Business', 'partial', '입력한 대화록 요약; 음성 전사는 미연동'),
    ('search', '기업 검색', 'Business', 'partial', '로컬 페이지 검색; 연결 앱 색인 미연동'),
    ('verification', '페이지 검증', 'Business', 'implemented', '담당자·검증 만료일 저장'),
    ('saml', 'SAML SSO', 'Business', 'configuration', 'IdP 메타데이터 설정; 서명 검증 로그인 흐름 미구현'),
    ('scim', 'SCIM 사용자·그룹 프로비저닝', 'Enterprise', 'implemented', 'SCIM 2.0 Users/Groups; FOUNTAIN_SCIM_TOKEN 필수'),
    ('audit', '감사 로그와 CSV 내보내기', 'Enterprise', 'implemented', '서버 변경 기록·검색·CSV; 외부 SIEM 미연동'),
    ('analytics', '워크스페이스 분석', 'Enterprise', 'implemented', '실제 조회·편집 이벤트 집계'),
    ('security', '공유 제한·게스트·보존 정책', 'Enterprise', 'implemented', '소유자·멤버 관리자 분리와 게스트·게시·내보내기 제한'),
    ('retention', '데이터 보존 정책', 'Enterprise', 'implemented', '만료 휴지통·회의 대화록 수동 정리'),
    ('integrations', '연결 앱·SIEM·DLP', 'Enterprise', 'configuration', '연결 설정 저장; 공급자 OAuth·동기화 미연동'),
    ('agents', '사용자 지정 AI 에이전트', 'Business', 'provider_required', '정해진 문서 작업 실행; 자율 외부 도구 실행 미지원'),
    ('offline', '오프라인', 'Plus', 'partial', '인터넷 없는 로컬 서버 사용; 서버 없는 편집·충돌 병합 미지원'),
    ('zero_retention', 'AI 공급자 데이터 무보존', 'Enterprise', 'provider_required', '사용하는 공급자 계약과 배포 설정으로 보장해야 함'),
    ('support', '전담 고객 성공·프리미엄 지원', 'Enterprise', 'service_required', '소프트웨어로 제공할 수 없는 인적 서비스'),
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Advanced:
    collections = {'teamspaces', 'members', 'groups', 'automations', 'forms', 'sites', 'integrations'}

    def __init__(self, store, workspace):
        self.store = store
        self.workspace = workspace
        if not store.get('settings', 'workspace'):
            store.put('settings', {'id': 'workspace', 'name': 'Fountain', 'disable_guests': False,
                                  'disable_public_sharing': False, 'disable_export': False,
                                  'trash_retention_days': 30, 'transcript_retention_days': 30})

    def settings(self):
        return self.store.get('settings', 'workspace') or {}

    def overview(self):
        return {**{kind: self.store.list(kind[:-1]) for kind in self.collections},
                'audit': self.store.list('audit')[-100:], 'settings': self.settings(),
                'features': self.capabilities()['features']}

    def capabilities(self):
        return {'mode': 'member-accounts' if self.store.meta('auth_accounts_required', False) else 'trusted-family-shared' if os.environ.get('FOUNTAIN_ACCESS_TOKEN') else 'local-single-user', 'features': [dict(zip(
            ('id', 'name', 'plan', 'status', 'detail'), item)) for item in FEATURES],
            'ai_configured': bool(os.environ.get('FOUNTAIN_AI_MODEL') and (os.environ.get('FOUNTAIN_AI_KEY') or self.local_ai())),
            'scim_configured': bool(os.environ.get('FOUNTAIN_SCIM_TOKEN')),
            'source': 'https://www.notion.com/pricing'}

    def item(self, kind, identity):
        item = self.store.get(kind[:-1] if kind in self.collections else kind, identity)
        require(item is not None, '항목을 찾을 수 없습니다', 404)
        return item

    def save(self, kind, body, identity=None):
        require(isinstance(body, dict), 'JSON 객체가 필요합니다')
        old = self.item(kind, identity) if identity else {}
        data = {**old, **body, 'id': identity or str(uuid4())}
        if kind in {'teamspaces', 'groups', 'automations', 'forms', 'sites', 'integrations'}:
            data['name'] = text(data.get('name', ''), '이름', 200)
        if kind == 'members':
            if 'active' in data: require(type(data['active']) is bool, '활성 상태는 참·거짓 값이어야 합니다')
            email = text(data.get('email', ''), '이메일', 254).casefold()
            require(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email), '올바른 이메일이 필요합니다')
            require(not any(m['id'] != data['id'] and isinstance(m.get('email'), str) and m['email'].strip().casefold() == email for m in self.store.list(kind[:-1])), '이미 등록된 이메일입니다', 409)
            require(data.get('role', 'member') in {'owner', 'admin', 'member', 'guest'}, '올바른 역할이 필요합니다')
            require(not (data.get('role') == 'guest' and self.settings().get('disable_guests')), '게스트가 비활성화되었습니다', 403)
            data['email'] = email
            data['name'] = text(data.get('name') or email.split('@')[0], '이름', 200)
            data.setdefault('role', 'member')
        if kind in {'groups', 'teamspaces'}:
            members = data.get('members', [])
            require(isinstance(members, list) and all(isinstance(m, str) for m in members), '멤버 ID 목록이 필요합니다')
            require(all(self.store.get('member', m) for m in members), '존재하지 않는 멤버입니다')
            if kind == 'teamspaces':
                groups = data.get('groups', [])
                require(isinstance(groups, list) and all(isinstance(group, str) and self.store.get('group', group) for group in groups), '유효한 그룹 ID 목록이 필요합니다')
                require(data.get('visibility', 'open') in {'open', 'closed', 'private'}, '잘못된 공개 범위입니다')
        if kind in {'forms', 'automations'}:
            database_id = data.get('database_id', 'projects')
            require(self.store.get('database', database_id), '대상 데이터베이스가 없습니다', 404)
            data['database_id'] = database_id
        if kind == 'forms':
            require(not self.settings().get('disable_public_sharing') or not data.get('published'), '공개 공유가 비활성화되었습니다', 403)
            fields = data.setdefault('fields', [])
            require(isinstance(fields, list) and len(fields) <= 100, '질문은 최대 100개입니다')
            seen = set()
            for field in fields:
                require(isinstance(field, dict), '질문 객체가 필요합니다')
                field['id'] = text(field.get('id', ''), '질문 ID', 100)
                require(field['id'] not in seen, '질문 ID가 중복됩니다')
                seen.add(field['id'])
                require(field.get('type', 'text') in {'text', 'number', 'select', 'email', 'date', 'checkbox'}, '지원하지 않는 질문 유형')
                condition = field.get('condition')
                if condition:
                    require(isinstance(condition, dict) and condition.get('field') in seen - {field['id']}, '조건은 앞선 질문을 참조해야 합니다')
        if kind == 'sites':
            require(not self.settings().get('disable_public_sharing') or not data.get('published'), '공개 공유가 비활성화되었습니다', 403)
            page = self.item('page', data.get('page_id', ''))
            require(not page.get('archived'), '삭제된 페이지는 게시할 수 없습니다')
            slug = data.get('slug', data['id'])
            require(isinstance(slug, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', slug), '주소에는 영문·숫자·밑줄·하이픈만 사용합니다')
            require(not any(s['id'] != data['id'] and s.get('slug') == slug for s in self.store.list('site')), '이미 사용 중인 주소입니다', 409)
            data['slug'] = slug
        if kind == 'automations':
            require(data.get('trigger', 'manual') in {'manual', 'row.created', 'row.updated'}, '지원하지 않는 실행 조건')
            actions = data.get('actions', [])
            require(isinstance(actions, list) and 0 < len(actions) <= 20, '작업은 1개 이상 20개 이하입니다')
            for action in actions:
                require(isinstance(action, dict) and action.get('type') in {'set_property', 'create_row', 'create_page'}, '지원하지 않는 자동화 작업')
        self.store.put(kind[:-1] if kind in self.collections else kind, data)
        self.store.audit(f'{kind}.{"updated" if identity else "created"}', {'id': data['id']})
        return self.item(kind, data['id'])

    @staticmethod
    def field_visible(field, answers):
        condition = field.get('condition')
        return not condition or answers.get(condition['field']) == condition.get('equals')

    def submit_form(self, identity, body):
        require(not self.settings().get('disable_public_sharing'), '공개 공유가 비활성화되었습니다', 403)
        form = self.item('forms', identity)
        require(form.get('published', False), '양식이 게시되지 않았습니다', 404)
        answers = body.get('answers', {})
        require(isinstance(answers, dict), '응답 객체가 필요합니다')
        values = {}
        for field in form['fields']:
            if not self.field_visible(field, answers):
                continue
            value = answers.get(field['id'])
            missing = value is None or value == '' or value == []
            require(not (field.get('required') and missing), f'{field.get("label", field["id"])}: 필수 응답입니다')
            if missing:
                continue
            field_type = field.get('type', 'text')
            require(isinstance(value, (str, int, float, bool)), '응답 형식이 잘못되었습니다')
            if field_type == 'number':
                require(type(value) in (int, float), '숫자 응답이 필요합니다')
            elif field_type == 'checkbox':
                require(type(value) is bool, '체크박스 응답이 필요합니다')
            elif field_type == 'select':
                require(value in field.get('options', []), '목록에서 선택해 주세요')
            else:
                require(isinstance(value, str) and len(value) <= 10000, '문자열 응답이 필요합니다')
            if field_type == 'email':
                require(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value), '올바른 이메일이 필요합니다')
            values[field.get('property_id', field['id'])] = value
        row = self.create_row(form['database_id'], values)
        submission = self.store.put('submission', {'id': str(uuid4()), 'form_id': identity, 'row_id': row['id'], 'answers': answers})
        self.store.audit('form.submitted', {'form_id': identity, 'row_id': row['id']})
        self.trigger('row.created', form['database_id'], row)
        return {'row': row, 'submission': submission}

    def create_row(self, database_id, values):
        if hasattr(self.workspace, 'create_row'):
            return self.workspace.create_row(database_id, {'values': values})
        return self.store.put('row', {'id': str(uuid4()), 'database_id': database_id, 'properties': values})

    def trigger(self, event, database_id, row):
        results = []
        for automation in self.store.list('automation'):
            if automation.get('enabled', True) and automation.get('trigger') == event and automation.get('database_id') == database_id:
                try:
                    results.append(self.run_automation(automation['id'], {'row_id': row['id']}))
                except (APIError, ValueError, KeyError) as error:
                    self.store.audit('automation.failed', {'id': automation['id'], 'error': str(error)})
        return results

    def run_automation(self, identity, body):
        with self.store.transaction():
            return self._run_automation(identity, body)

    def _run_automation(self, identity, body):
        automation = self.item('automations', identity)
        require(automation.get('enabled', True), '비활성화된 자동화입니다', 409)
        row_id = body.get('row_id')
        row = self.item('row', row_id) if row_id else None
        if row:
            require(row.get('database_id') == automation['database_id'], '다른 데이터베이스의 행입니다')
        conditions = automation.get('conditions', {})
        require(isinstance(conditions, dict), '조건 객체가 필요합니다')
        if conditions and (not row or any(row.get('properties', {}).get(k) != v for k, v in conditions.items())):
            return {'skipped': True, 'reason': '조건 불일치'}
        require(row is not None or not any(a['type'] == 'set_property' for a in automation['actions']), '속성을 변경할 행을 지정해 주세요')
        results = []
        for action in automation['actions']:
            if action['type'] == 'set_property':
                key = text(action.get('property_id', ''), '속성 ID', 100)
                row = self.workspace.update_row(automation['database_id'], row_id, {'properties': {key: action.get('value')}})
                results.append({'type': action['type'], 'row_id': row_id})
            elif action['type'] == 'create_row':
                results.append(self.create_row(automation['database_id'], action.get('values', {})))
            else:
                title = text(action.get('title', ''), '페이지 제목', 500)
                if hasattr(self.workspace, 'create_page'):
                    results.append(self.workspace.create_page({'title': title}))
        self.store.audit('automation.executed', {'id': identity, 'row_id': row_id, 'actions': len(results)})
        return {'results': results, 'executed_at': now()}

    def update_settings(self, body):
        allowed = {'name', 'disable_guests', 'disable_public_sharing', 'disable_export', 'trash_retention_days',
                   'transcript_retention_days', 'saml_metadata_url', 'saml_entity_id', 'custom_domain'}
        require(not (set(body) - allowed), '지원하지 않는 설정입니다')
        for key in ('disable_guests', 'disable_public_sharing', 'disable_export'):
            if key in body:
                require(type(body[key]) is bool, '보안 설정에는 참·거짓 값이 필요합니다')
        for key in ('trash_retention_days', 'transcript_retention_days'):
            if key in body:
                require(type(body[key]) is int and 1 <= body[key] <= 3650, '보존 기간은 1~3650일입니다')
        for key in ('saml_metadata_url',):
            if body.get(key):
                require(isinstance(body[key], str) and urllib.parse.urlparse(body[key]).scheme == 'https', 'HTTPS 메타데이터 URL이 필요합니다')
        data = {**self.settings(), **body}
        self.store.put('settings', data)
        self.store.audit('settings.updated', {'fields': list(body)})
        return data

    def analytics(self):
        events = self.store.list('audit')
        counts, pages, days = {}, {}, {}
        for event in events:
            action = event.get('action', '')
            counts[action] = counts.get(action, 0) + 1
            date = event.get('created_at', '')[:10]
            days[date] = days.get(date, 0) + 1
            details = event.get('details', {})
            if isinstance(details, dict):
                page_id = details.get('page_id')
                if page_id:
                    pages[page_id] = pages.get(page_id, 0) + 1
        return {'events': len(events), 'actions': counts, 'pages': pages, 'daily': days,
                'members': len(self.store.list('member')), 'page_count': len([p for p in self.store.list('page') if not p.get('archived')]),
                'rows': len(self.store.list('row'))}

    def cleanup(self):
        settings = self.settings()
        timestamp = time.time()
        removed = {'pages': 0, 'transcripts': 0}
        for kind, age_key, key in [('page', 'trash_retention_days', 'deleted_at'), ('transcript', 'transcript_retention_days', 'created_at')]:
            for item in self.store.list(kind):
                if kind == 'page' and not item.get('archived'):
                    continue
                date = item.get(key)
                try:
                    expired = timestamp - datetime.fromisoformat(date).timestamp() > settings.get(age_key, 30) * 86400
                except (TypeError, ValueError):
                    expired = False
                if expired:
                    self.store.delete(kind, item['id'])
                    if kind == 'page':
                        for child_kind in ('version', 'comment'):
                            for child in self.store.list(child_kind):
                                if child.get('page_id') == item['id']:
                                    self.store.delete(child_kind, child['id'])
                    removed['pages' if kind == 'page' else 'transcripts'] += 1
        self.store.audit('retention.executed', removed)
        return removed

    @staticmethod
    def local_ai():
        endpoint = urllib.parse.urlparse(os.environ.get('FOUNTAIN_AI_URL', ''))
        return endpoint.scheme == 'http' and endpoint.hostname in {'localhost', '127.0.0.1', '::1'}

    def ai(self, body):
        key = os.environ.get('FOUNTAIN_AI_KEY')
        require(key or self.local_ai(), 'AI가 설정되지 않았습니다. 무료 로컬 모델의 FOUNTAIN_AI_URL과 FOUNTAIN_AI_MODEL을 설정해 주세요.', 503)
        model = os.environ.get('FOUNTAIN_AI_MODEL')
        require(model, 'FOUNTAIN_AI_MODEL에 사용할 모델 이름을 설정해 주세요.', 503)
        action = body.get('action', 'answer')
        instructions = {'summarize': '주어진 문서를 한국어로 간결하게 요약하세요.', 'write': '사용자 요청에 맞춰 문서를 작성하세요.',
                        'translate': '사용자가 요청한 언어로 번역하세요.', 'answer': '주어진 문맥으로 답하고 근거 없는 주장을 하지 마세요.',
                        'meeting': '회의 대화록을 결정 사항, 담당자와 후속 작업으로 정리하세요.', 'autofill': '요청한 데이터베이스 속성 값을 제안하세요.'}
        require(action in instructions, '지원하지 않는 AI 작업입니다')
        prompt = text(body.get('prompt', ''), '프롬프트', 50000)
        context = ''
        if body.get('page_id'):
            page = self.item('page', body['page_id'])
            require(not page.get('archived'), '삭제된 페이지입니다', 404)
            blocks = page.get('blocks', [])
            context = page.get('title', '') + '\n' + '\n'.join(b.get('text', '') for b in blocks)
        endpoint = os.environ.get('FOUNTAIN_AI_URL', 'https://api.openai.com/v1/chat/completions')
        parsed = urllib.parse.urlparse(endpoint)
        require(parsed.scheme == 'https' or (parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'}), 'AI 공급자 연결에는 HTTPS가 필요합니다', 503)
        payload = {'model': model,
                   'messages': [{'role': 'system', 'content': instructions[action]}, {'role': 'user', 'content': f'{prompt}\n\n문서:\n{context}'}]}
        headers = {'Content-Type': 'application/json'}
        if key: headers['Authorization'] = f'Bearer {key}'
        request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers=headers)
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=45) as response:
                result = json.loads(response.read(2_000_000))
            output = result['choices'][0]['message']['content']
            require(isinstance(output, str), 'AI 응답 형식이 잘못되었습니다', 502)
        except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError, TimeoutError) as error:
            raise AdvancedError('AI 공급자가 응답하지 않았거나 올바르지 않은 응답을 반환했습니다', 502) from error
        self.store.audit('ai.executed', {'action': action, 'page_id': body.get('page_id')})
        return {'text': output, 'provider': parsed.hostname, 'model': payload['model'], 'citations': ([{'page_id': body['page_id']}] if context else [])}

    def clipboard(self, body):
        blocks = body.get('blocks', [])
        require(isinstance(blocks, list) and len(blocks) <= 1000, '블록 목록이 필요합니다')
        pieces, plain = [], []
        for block in blocks:
            require(isinstance(block, dict) and isinstance(block.get('text', ''), str), '블록 형식이 잘못되었습니다')
            value = block.get('text', '')
            require(len(value) <= 100000, '블록이 너무 큽니다')
            plain.append(value)
            tag = {'heading1': 'h1', 'heading2': 'h2', 'heading3': 'h3', 'quote': 'blockquote', 'code': 'pre'}.get(block.get('type'), 'p')
            pieces.append(f'<{tag}>{html.escape(value)}</{tag}>')
        identity = str(uuid4())
        self.store.put('clipboard', {'id': identity, 'owner_id': AUDIT_ACTOR.get(), 'blocks': blocks})
        for entry in self.store.list('clipboard')[:-20]:
            self.store.delete('clipboard', entry['id'])
        # A local copy token preserves structure without placing executable markup on the clipboard.
        return {'id': identity, 'text': '\n'.join(plain), 'html': ''.join(pieces) + f'<!-- fountain-copy: {identity} -->'}

    def scim(self, method, path, body, query):
        from .scim import scim_resource
        return scim_resource(self, method, path, body, query)

    def public_view(self, path):
        from .publishing import render_public
        return render_public(self, path)

    def dispatch(self, method, path, body, query):
        if method == 'GET' and path.startswith(('/sites/', '/forms/')):
            return self.public_view(path)
        if path.startswith('/scim/v2/'):
            return self.scim(method, path, body, query)
        if path == '/api/advanced' and method == 'GET':
            return 200, self.overview()
        if path == '/api/capabilities' and method == 'GET':
            return 200, self.capabilities()
        if path == '/api/settings' and method in {'PATCH', 'PUT'}:
            return 200, self.update_settings(body)
        if path == '/api/analytics' and method == 'GET':
            return 200, self.analytics()
        if path == '/api/retention/run' and method == 'POST':
            return 200, self.cleanup()
        if path == '/api/ai' and method == 'POST':
            return 200, self.ai(body)
        if path == '/api/clipboard' and method == 'POST':
            return 200, self.clipboard(body)
        if path.startswith('/api/clipboard/') and method == 'GET':
            return 200, self.item('clipboard', path.rsplit('/', 1)[1])
        if path == '/api/audit' and method == 'GET':
            events = self.store.list('audit')
            search = query.get('q', [''])[0].casefold()
            return 200, {'events': [e for e in events if search in json.dumps(e, ensure_ascii=False).casefold()]}
        parts = path.strip('/').split('/')
        if len(parts) == 4 and parts[:2] == ['api', 'pages'] and parts[3] == 'verify':
            page = self.item('page', parts[2])
            if method == 'POST':
                owner = body.get('owner', 'local')
                require(self.store.get('member', owner), '검증 담당자가 없습니다', 404)
                expiry = body.get('expires_at')
                if expiry:
                    try:
                        parsed = datetime.fromisoformat(expiry)
                        require(parsed.tzinfo is not None and parsed.timestamp() > time.time(), '검증 만료일은 시간대가 있는 미래 시각이어야 합니다')
                    except (TypeError, ValueError) as error:
                        raise AdvancedError('검증 만료일 형식이 잘못되었습니다') from error
                page['verification'] = {'owner': owner, 'verified_by': AUDIT_ACTOR.get(), 'verified_at': now(), 'expires_at': expiry}
            elif method == 'DELETE':
                page.pop('verification', None)
            else:
                return None
            self.store.put('page', page)
            self.store.audit('page.verification.updated', {'page_id': page['id']})
            return 200, page
        if len(parts) >= 2 and parts[0] == 'api' and parts[1] in self.collections:
            kind = parts[1]
            identity = parts[2] if len(parts) > 2 else None
            if len(parts) == 4 and method == 'POST':
                if kind == 'forms' and parts[3] == 'submit':
                    return 201, self.submit_form(identity, body)
                if kind == 'automations' and parts[3] == 'run':
                    return 200, self.run_automation(identity, body)
                return None
            if method == 'GET':
                return 200, (self.item(kind, identity) if identity else {kind: self.store.list(kind[:-1])})
            if method == 'POST' and identity is None:
                return 201, self.save(kind, body)
            if method == 'PATCH' and identity:
                return 200, self.save(kind, body, identity)
            if method == 'DELETE' and identity:
                self.item(kind, identity)
                self.store.delete(kind[:-1] if kind in self.collections else kind, identity)
                self.store.audit(f'{kind}.deleted', {'id': identity})
                return 200, {'deleted': True}
        return None
