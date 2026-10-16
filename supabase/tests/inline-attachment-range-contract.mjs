/** SQL source/catalog-assertion contracts and independent Python 3.12 oracle.
 * No PostgreSQL parser, live Auth, row locks, catalog query or cloud I/O runs. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const directory=new URL('../migrations/',import.meta.url);
const files=readdirSync(directory).filter(name=>/^(?:pending|\d{14})_fountain_cloud_inline_attachment_range\.sql$/.test(name));
assert.equal(files.length,1,'One pending OR exact applied migration must exist, never ambiguous snapshots');
const sql=readFileSync(new URL(files[0],directory),'utf8'),code=sql.replace(/--[^\n]*/g,'');
const privateBody=code.split('AS $$')[1].split('$$;')[0];
const signature='jsonb,text,jsonb,bigint,integer,text';
const authority=readFileSync(new URL('../migrations/20261016100057_fountain_cloud_atomic_store.sql',import.meta.url),'utf8');

test('both wrappers retain exact six-input DTO, locked search paths and only service-role execute',()=>{
 assert.equal((code.match(/CREATE FUNCTION /g)||[]).length,2);
 assert(code.includes('LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog'));
 assert(code.includes('LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog'));
 for(const name of ['fountain_cloud.inline_attachment_range','public.fountain_cloud_inline_attachment_range']){
  assert(code.includes(`ALTER FUNCTION ${name}(${signature}) OWNER TO postgres;`));
  assert(code.includes(`REVOKE ALL ON FUNCTION ${name}(${signature}) FROM PUBLIC,anon,authenticated,service_role;`));
  assert(code.includes(`GRANT EXECUTE ON FUNCTION ${name}(${signature}) TO service_role;`));
 }
 for(const key of ['workspaceId','attachmentId','offset','size','sha256','sourceDigest','bytesBase64'])assert(privateBody.includes("'"+key+"'"));
 assert(!/GRANT (?:SELECT|INSERT|UPDATE|DELETE|USAGE)|CREATE TABLE|ALTER TABLE|CREATE EXTENSION/.test(code));
});
test('actual apply will assert catalog owner/definer/path and negative anon/authenticated privileges',()=>{
 assert(code.includes('DO $$'));assert(code.includes('pg_proc'));assert(code.includes('pg_roles'));
 assert(code.includes("r.rolname='postgres' AND p.prosecdef"));assert(code.includes("r.rolname='postgres' AND NOT p.prosecdef"));
 assert.equal((code.match(/'search_path=pg_catalog'=ANY\(p.proconfig\)/g)||[]).length,2);
 for(const role of ['service_role','anon','authenticated'])for(const fn of ['v_impl','v_wire'])assert(code.includes(`has_function_privilege('${role}',${fn},'EXECUTE')`));
});
test('fresh human auth and workspace lock precede exact namespace lookup, without fake owner or service authority',()=>{
 assert(privateBody.indexOf("current_setting('transaction_isolation')")<privateBody.indexOf('store_context(p_context)'));
 assert(privateBody.indexOf('store_context(p_context)')<privateBody.indexOf('SELECT e.data INTO v_source'));
 assert(privateBody.includes("v_workspace:=p_context->>'workspaceId'"));
 assert(privateBody.includes("e.workspace_id=v_workspace AND e.kind='attachment' AND e.id=p_attachment_id FOR SHARE OF e"));
 assert(authority.includes('PERFORM fountain_cloud.store_lock(ws)'));for(const relation of ['session_vault','auth.sessions','auth.users','identity_mapping'])assert(authority.includes(relation));
 assert(!/service_context|user_metadata|jwt|owner'|admin'/.test(privateBody));
});
test('metadata exactness, inline-only shape and cloud overlay exclusion prevent silent fallback',()=>{
 for(const fragment of ["jsonb_typeof(p_expected) IS DISTINCT FROM 'object'","p_expected ? 'data'","octet_length(p_expected::text)>65536","(v_source-'data') IS DISTINCT FROM p_expected","v_source ?| ARRAY['cloud_chunks','storage_id']","v_source->'storage' IS DISTINCT FROM 'null'::jsonb","v_source->'storage' IS DISTINCT FROM '\"inline\"'::jsonb","o.workspace_id=v_workspace AND o.kind='attachment_cloud' AND o.id=p_attachment_id","jsonb_typeof(v_source->'size') IS DISTINCT FROM 'number'","jsonb_typeof(v_source->'data') IS DISTINCT FROM 'string'"])assert(privateBody.includes(fragment),fragment);
 assert(privateBody.includes('v_size<0 OR v_size>5000000 OR v_size<>trunc(v_size)'));
});
test('complete bounded base64 validation precedes every preflight/range result including corrupt suffixes',()=>{
 for(const fragment of ["octet_length(v_encoded)>7000000","length(v_encoded)%4<>0","v_encoded ~ '[^A-Za-z0-9+/=]'","v_core:=rtrim(v_encoded,'=')","v_padding>2 OR strpos(v_core,'=')>0 OR v_mod=1","v_mod=0 AND v_padding<>0","v_mod=2 AND v_padding<>2","v_mod=3 AND v_padding<>1","decode(v_encoded,'base64')","octet_length(v_decoded)<>v_size"])assert(privateBody.includes(fragment),fragment);
 assert(privateBody.indexOf("decode(v_encoded,'base64')")<privateBody.indexOf('RETURN jsonb_build_object'));
 assert(!privateBody.includes('encode(v_decoded,\'base64\')=v_encoded'),'Do not newly reject nonzero legacy pad bits');
});
test('whole raw JSON and full content hashes are distinct and stale digest is never a byte read',()=>{
 assert(privateBody.includes("pg_catalog.sha256(convert_to(v_source::text,'UTF8'))"));assert(privateBody.includes('pg_catalog.sha256(v_decoded)'));
 assert(privateBody.includes("p_source_digest IS NULL AND (p_offset<>0 OR p_length<>0)"));assert(privateBody.includes("p_source_digest !~ '^[a-f0-9]{64}$'"));
 assert(privateBody.includes('p_source_digest IS DISTINCT FROM v_source_digest'));
 assert(privateBody.includes("v_source ? 'sha256'"));assert(privateBody.includes("v_source->>'sha256' IS DISTINCT FROM v_content_sha"));
 assert(privateBody.includes('p_length NOT BETWEEN 0 AND 65536'));assert(privateBody.includes('p_offset>v_size OR p_length>v_size-p_offset'));
 assert(privateBody.includes("substring(v_decoded FROM (p_offset+1)::integer FOR p_length)"));assert(privateBody.includes("E'\\n',''"));
});
test('all source errors are static typed denials and no original/receipt/quota/Storage write exists',()=>{
 assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE|COPY)\b/.test(privateBody));assert(!/sessionHash|bytesBase64.*v_encoded|SQLERRM|SQLSTATE\s*\|\||GET STACKED DIAGNOSTICS/.test(privateBody));
 for(const status of ['400','401','404','409','503'])assert(code.includes("SQLSTATE 'PT"+status+"'"));
 assert(privateBody.includes("WHEN OTHERS THEN RAISE EXCEPTION 'Inline attachment is unavailable' USING ERRCODE='PT503'"));
});

// An independent implementation of the documented grammar is compared with the
// exact approved Python runtime, not presented as execution of the SQL above.
function grammar(value){
 if(typeof value!=='string'||Buffer.byteLength(value)>7000000||value.length%4||/[^A-Za-z0-9+/=]/.test(value))return null;
 const core=value.replace(/=+$/,''),padding=value.length-core.length,mod=core.length%4;
 if(padding>2||core.includes('=')||mod===1||mod===0&&padding!==0||mod===2&&padding!==2||mod===3&&padding!==1)return null;
 return Buffer.from(value,'base64').toString('hex');
}
test('approved Python 3.12 strict legacy oracle accepts pad bits but rejects excess/internal pad and whitespace',t=>{
 const candidates=[process.env.FOUNTAIN_PYTHON,fileURLToPath(new URL('../../.data/supabase-venv/bin/python',import.meta.url)),join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')].filter(Boolean);
 const python=candidates.find(existsSync);if(!python){t.skip('Approved Python 3.12 oracle unavailable; no SQL runtime claim');return;}
 const values=['','AA==','AB==','AAA=','AAB=','AAAA','AAAA=','AAAA==','AAAA===','AAA==','AA===','AA==AA==','AA=A','A===','AA','AAA','AAAAA','A A==','AA==\n','AA==junk','====','=','==','AA==!','AA==\x00'];
 for(let n=0;n<=24;n++)for(let p=0;p<=5;p++)values.push('A'.repeat(n)+'='.repeat(p));
 const oracle=spawnSync(python,['-c',"import sys,json,base64\nassert sys.version_info[:2]==(3,12), 'Python 3.12 baseline required'\nresult=[]\nfor s in json.load(sys.stdin):\n try: result.append(base64.b64decode(s,validate=True).hex())\n except (ValueError,TypeError): result.append(None)\nprint(json.dumps(result))"],{input:JSON.stringify(values),encoding:'utf8',maxBuffer:1024*1024});
 assert.equal(oracle.status,0,oracle.stderr);const expected=JSON.parse(oracle.stdout);for(let index=0;index<values.length;index++)assert.equal(grammar(values[index]),expected[index],JSON.stringify(values[index]));
 assert.equal(grammar('AB=='),'00');assert.equal(grammar('AAB='),'0000');assert.equal(grammar('AA==!'),null);assert.equal(grammar('A'.repeat(7000004)),null);
});
