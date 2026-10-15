"""SCIM 2.0 user/group protocol projection for local provisioning."""
def scim_resource(service, method, path, body, query):
    from .advanced import AdvancedError, require
    resource = path.split('/')[3:]
    schemas = {'Users': 'urn:ietf:params:scim:schemas:core:2.0:User', 'Groups': 'urn:ietf:params:scim:schemas:core:2.0:Group'}
    if resource == ['ServiceProviderConfig']:
        return 200, {'schemas': ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], 'patch': {'supported': True}, 'filter': {'supported': False}, 'bulk': {'supported': False}}
    require(resource and resource[0] in schemas, 'SCIM 리소스를 찾을 수 없습니다', 404)
    category = resource[0]
    kind = 'members' if category == 'Users' else 'groups'
    identity = resource[1] if len(resource) > 1 else None
    def represent(item):
        base = {'schemas': [schemas[category]], 'id': item['id'], 'meta': {'resourceType': category[:-1]}}
        if category == 'Users':
            return {**base, 'userName': item['email'], 'displayName': item.get('name', ''), 'active': item.get('active', True)}
        return {**base, 'displayName': item['name'], 'members': [{'value': m} for m in item.get('members', [])]}
    if method == 'GET':
        if identity:
            return 200, represent(service.item(kind, identity))
        require(not query.get('filter'), 'SCIM 필터는 지원하지 않습니다', 400)
        items = service.store.list(kind[:-1] if kind in service.collections else kind)
        try:
            start, count = max(1, int(query.get('startIndex', ['1'])[0])), max(0, min(1000, int(query.get('count', ['100'])[0])))
        except ValueError as error:
            raise AdvancedError('페이지 범위가 올바르지 않습니다') from error
        return 200, {'schemas': ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], 'totalResults': len(items), 'startIndex': start, 'itemsPerPage': len(items[start-1:start-1+count]), 'Resources': [represent(i) for i in items[start-1:start-1+count]]}
    if method == 'DELETE' and identity:
        service.item(kind, identity)
        service.store.delete(kind[:-1] if kind in service.collections else kind, identity)
        service.store.audit('scim.deleted', {'kind': kind, 'id': identity})
        return 204, None
    require(method in {'POST', 'PUT', 'PATCH'}, '지원하지 않는 SCIM 메서드입니다', 405)
    require((method == 'POST') == (identity is None), 'SCIM 주소가 올바르지 않습니다')
    if method == 'PATCH':
        current = represent(service.item(kind, identity))
        for op in body.get('Operations', []):
            require(op.get('op', '').lower() in {'replace', 'add'}, '지원하지 않는 SCIM 작업입니다')
            if op.get('path'):
                require(op['path'] in {'active', 'displayName', 'userName', 'members'}, '지원하지 않는 SCIM 경로입니다')
                if op['path'] == 'members' and op.get('op', '').lower() == 'add':
                    incoming = op.get('value')
                    require(isinstance(incoming, list), '멤버 목록이 필요합니다')
                    existing = {m['value']: m for m in current.get('members', [])}
                    require(all(isinstance(m, dict) and isinstance(m.get('value'), str) for m in incoming), '멤버 ID가 필요합니다')
                    existing.update({m['value']: m for m in incoming})
                    current['members'] = list(existing.values())
                else:
                    current[op['path']] = op.get('value')
            else:
                require(isinstance(op.get('value'), dict), 'SCIM 값 객체가 필요합니다')
                current.update(op['value'])
        body = current
    if category == 'Users':
        require(type(body.get('active', True)) is bool, 'active 값이 올바르지 않습니다')
        data = {'email': body.get('userName', ''), 'name': body.get('displayName', ''), 'active': body.get('active', True)}
    else:
        require(isinstance(body.get('members', []), list), '멤버 목록이 필요합니다')
        data = {'name': body.get('displayName', ''), 'members': [m.get('value') for m in body.get('members', []) if isinstance(m, dict)]}
    result = service.save(kind, data, identity)
    return (201 if method == 'POST' else 200), represent(result)

