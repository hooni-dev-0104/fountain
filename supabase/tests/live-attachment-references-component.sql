-- Rollback-only PostgreSQL component. Synthetic Auth rows exercise the actual
-- unmodified store_context joins, not a GoTrue login or live Edge journey.
DO $references$
DECLARE ws text:='qa_live_attachment_refs_'||replace(gen_random_uuid()::text,'-','');other text:=ws||'_other';identity text:=repeat('문',159)||'🚰';stamp text:='2026-10-17T13:00:00.000000Z';ctx jsonb;answer jsonb;uid uuid:=gen_random_uuid();sid uuid:=gen_random_uuid();ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;role_name text;variant jsonb;raw_bytes bigint;before_revision bigint;after_revision bigint;iteration integer;
BEGIN
 PERFORM fountain_cloud.store_lock(ws);PERFORM set_config('fountain.workspace_id',ws,true);
 INSERT INTO fountain_private.entities VALUES(ws,'page','large',jsonb_build_object('id','large','title','Header','blocks',jsonb_build_array(jsonb_build_object('type','file','attachment_id',identity,'text',repeat('x',4194304)))) ,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(other,'page','outside',jsonb_build_object('id','outside','blocks',jsonb_build_array(jsonb_build_object('attachment_id','other-only'))),stamp,stamp);
 EXECUTE 'SET LOCAL ROLE fountain_backend';
 IF NOT fountain_private.attachment_referenced(ws,identity) OR fountain_private.attachment_referenced(ws,'other-only') OR fountain_private.attachment_referenced(ws,'missing') THEN RAISE EXCEPTION 'Large body, Unicode or namespace reference mismatch';END IF;
 BEGIN PERFORM fountain_private.attachment_referenced(other,identity);RAISE EXCEPTION 'Cross namespace scalar accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM fountain_private.attachment_referenced(ws,NULL);RAISE EXCEPTION 'NULL attachment identity accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM fountain_private.attachment_referenced(ws,'');RAISE EXCEPTION 'Empty attachment identity accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM fountain_private.attachment_referenced(ws,repeat('a',161));RAISE EXCEPTION 'Oversized attachment identity accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 EXECUTE 'RESET ROLE';
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='page';
 INSERT INTO fountain_private.entities VALUES(ws,'version','v',jsonb_build_object('id','v','page_id','p','blocks',jsonb_build_array(jsonb_build_object('attachment_id',identity))),stamp,stamp);
 IF NOT fountain_private.attachment_referenced(ws,identity) THEN RAISE EXCEPTION 'Version attachment reference missed';END IF;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='version';
 FOR variant IN SELECT replace(value::text,'"TARGET"',to_jsonb(identity)::text)::jsonb FROM jsonb_array_elements('[{"blocks":{"x":{"fields":{"attachment_id":{"value":"TARGET"}}}}},{"history":{"baseline":{"blocks":{"x":{"fields":{"attachment_id":{"value":"TARGET"}}}}}}},{"history":{"ops":{"old":{"type":"block.set","field":"attachment_id","value":"TARGET"},"new":{"type":"block.set","field":"attachment_id","value":null}}}}]'::jsonb) LOOP
  INSERT INTO fountain_private.entities VALUES(ws,'collaboration','p',jsonb_build_object('id','p','state',variant),stamp,stamp);
  IF NOT fountain_private.attachment_referenced(ws,identity) THEN RAISE EXCEPTION 'Typed latent CRDT reference missed';END IF;
  DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='collaboration';
 END LOOP;
 INSERT INTO fountain_private.entities VALUES(ws,'collaboration','fake',jsonb_build_object('id','fake','attachment_id',identity,'state',jsonb_build_object('arbitrary',jsonb_build_object('attachment_id',identity),'history',jsonb_build_object('ops',jsonb_build_object('not-field',jsonb_build_object('type','text.insert','field','attachment_id','value',identity))))),stamp,stamp);
 IF fountain_private.attachment_referenced(ws,identity) THEN RAISE EXCEPTION 'Arbitrary JSON manufactured an attachment reference';END IF;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='collaboration';
 INSERT INTO fountain_private.entities VALUES(ws,'database','db','{"id":"db","properties":[{"id":"files","type":"files"},{"id":"other","type":"text"}]}'::jsonb,stamp,stamp);
 INSERT INTO fountain_private.entities VALUES(ws,'row','row',jsonb_build_object('id','row','database_id','db','properties',jsonb_build_object('files',jsonb_build_array(identity),'other','not-a-file')),stamp,stamp);
 IF NOT fountain_private.attachment_referenced(ws,identity) THEN RAISE EXCEPTION 'Current typed row files reference missed';END IF;
 -- Legacy files normalize scalar IDs and object entries without substring
 -- matching; missing/null/empty values are empty, malformed values fail closed.
 FOR variant IN SELECT x FROM jsonb_array_elements(jsonb_build_array(to_jsonb(identity),jsonb_build_array(jsonb_build_object('id',identity,'name','legacy attachment')))) x LOOP
  UPDATE fountain_private.entities SET data=jsonb_set(data,'{properties,files}',variant) WHERE workspace_id=ws AND kind='row' AND id='row';
  IF NOT fountain_private.attachment_referenced(ws,identity) THEN RAISE EXCEPTION 'Legacy exact file ID was missed';END IF;
 END LOOP;
 FOR variant IN SELECT x FROM jsonb_array_elements(jsonb_build_array('null'::jsonb,'""'::jsonb,'[]'::jsonb,to_jsonb('prefix-needle-suffix'::text))) x LOOP
  UPDATE fountain_private.entities SET data=jsonb_set(data,'{properties,files}',variant) WHERE workspace_id=ws AND kind='row' AND id='row';
  IF fountain_private.attachment_referenced(ws,identity) OR fountain_private.attachment_referenced(ws,'needle') THEN RAISE EXCEPTION 'Empty or substring file value became a reference';END IF;
 END LOOP;
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{properties}','{}') WHERE workspace_id=ws AND kind='row' AND id='row';
 IF fountain_private.attachment_referenced(ws,identity) THEN RAISE EXCEPTION 'Missing files field became a reference';END IF;
 FOR variant IN SELECT x FROM jsonb_array_elements('[42,true,{},[null],[42],[{"id":42}],[{"id":""}],[["nested"]]]'::jsonb) x LOOP
  UPDATE fountain_private.entities SET data=jsonb_set(data,'{properties,files}',variant) WHERE workspace_id=ws AND kind='row' AND id='row';
  BEGIN PERFORM fountain_private.attachment_referenced(ws,identity);RAISE EXCEPTION 'Malformed files source did not fail closed';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
 END LOOP;
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{properties}',jsonb_build_object('files',jsonb_build_array(identity))) WHERE workspace_id=ws AND kind='row' AND id='row';
 FOR variant IN SELECT x FROM jsonb_array_elements('[null,{},[null],[{"id":"files"}]]'::jsonb) x LOOP
  BEGIN
   UPDATE fountain_private.entities SET data=jsonb_set(data,'{properties}',variant) WHERE workspace_id=ws AND kind='database' AND id='db';
   BEGIN PERFORM fountain_private.attachment_referenced(ws,identity);RAISE EXCEPTION 'Malformed current schema did not fail closed';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
   RAISE EXCEPTION USING ERRCODE='Z0003',MESSAGE='rollback schema fixture';
  EXCEPTION WHEN SQLSTATE 'Z0003' THEN NULL;END;
 END LOOP;
 BEGIN
  DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind='database' AND id='db';
  BEGIN PERFORM fountain_private.attachment_referenced(ws,identity);RAISE EXCEPTION 'Missing database did not fail closed';EXCEPTION WHEN SQLSTATE 'PT503' THEN NULL;END;
  RAISE EXCEPTION USING ERRCODE='Z0003',MESSAGE='rollback database fixture';
 EXCEPTION WHEN SQLSTATE 'Z0003' THEN NULL;END;
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{properties}','[{"id":"files","type":"text"}]') WHERE workspace_id=ws AND kind='database' AND id='db';
 IF fountain_private.attachment_referenced(ws,identity) THEN RAISE EXCEPTION 'Old database schema still grants a file reference';END IF;
 DELETE FROM fountain_private.entities WHERE workspace_id=ws AND kind IN('row','database');
 -- Actual store_context: valid synthetic Auth row/session/mapping/vault, no
 -- owner impersonation or replacement of the function under test.
 INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at) VALUES(uid,'authenticated','authenticated','qa-'||uid||'@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp());
 INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after) VALUES(sid,uid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour');
 INSERT INTO fountain_private.entities VALUES(ws,'member','member',jsonb_build_object('id','member','name','Synthetic component member','email','qa@example.invalid','role','member','active',true),stamp,stamp);
 INSERT INTO fountain_private.identity_mapping VALUES(ws,uid,'member',clock_timestamp());
 INSERT INTO fountain_cloud.session_vault(workspace_id,hash,user_id,auth_session_id,cache_binding,created_at_ms,expires_at_ms,token_ciphertext) VALUES(ws,repeat('a',64),uid,sid,repeat('b',32),ms,ms+604800000,jsonb_build_object('version',1,'keyId','qa','iv',repeat('A',16),'data',repeat('A',22)));
 ctx:=jsonb_build_object('workspaceId',ws,'memberId','member','userId',uid,'authSessionId',sid,'sessionHash',repeat('a',64),'cacheBinding',repeat('b',32));
 INSERT INTO fountain_private.entities VALUES(ws,'collaboration','latent',jsonb_build_object('id','latent','state',jsonb_build_object('body',repeat('x',4194304),'history',jsonb_build_object('ops',jsonb_build_object('latent',jsonb_build_object('type','block.set','field','attachment_id','value',identity))))),stamp,stamp);
 EXECUTE 'SET LOCAL ROLE service_role';
 answer:=public.fountain_cloud_store_attachment_references(ctx,identity);
 IF answer-ARRAY['context','attachmentId','revision','referenced']<>'{}'::jsonb OR NOT(answer ?& ARRAY['context','attachmentId','revision','referenced']) OR answer->'context' IS DISTINCT FROM ctx OR answer->>'attachmentId' IS DISTINCT FROM identity OR answer->'referenced' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(answer->'revision')<>'number' OR octet_length(answer::text)>4096 THEN RAISE EXCEPTION 'Exact bounded scalar DTO mismatch';END IF;
 BEGIN PERFORM fountain_private.attachment_referenced(ws,identity);RAISE EXCEPTION 'Service role directly accessed private scalar';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 EXECUTE 'RESET ROLE';
 before_revision:=(answer->>'revision')::bigint;
 INSERT INTO fountain_private.meta VALUES(ws,'_entity_revision',to_jsonb(before_revision+1)) ON CONFLICT(workspace_id,key) DO UPDATE SET data=EXCLUDED.data;
 answer:=public.fountain_cloud_store_attachment_references(ctx,identity);after_revision:=(answer->>'revision')::bigint;
 IF after_revision<>before_revision+1 THEN RAISE EXCEPTION 'Current source revision was stale';END IF;
 BEGIN PERFORM fountain_cloud.store_apply_changes_locked(ws,before_revision,'[]');RAISE EXCEPTION 'Stale reference revision could commit';EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;END;
 -- Every business role remains governed by the same fresh active member join;
 -- actual attachment authorization remains the prior Files.remove requirement.
 FOREACH role_name IN ARRAY ARRAY['owner','admin','member','guest'] LOOP
  UPDATE fountain_private.entities SET data=jsonb_set(data,'{role}',to_jsonb(role_name)) WHERE workspace_id=ws AND kind='member' AND id='member';
  answer:=public.fountain_cloud_store_attachment_references(ctx,identity);
  IF answer->'referenced' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Fresh member role scalar failed';END IF;
 END LOOP;
 UPDATE fountain_private.entities SET data=jsonb_set(data,'{role}','"member"') WHERE workspace_id=ws AND kind='member' AND id='member';
 FOR iteration IN 1..8 LOOP
  BEGIN
   IF iteration=1 THEN UPDATE fountain_cloud.session_vault SET token_ciphertext=NULL,revoked_at_ms=ms+1 WHERE workspace_id=ws;
   ELSIF iteration=2 THEN UPDATE fountain_cloud.session_vault SET logout_pending=true,revoked_at_ms=ms+1 WHERE workspace_id=ws;
   ELSIF iteration=3 THEN UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 minute' WHERE id=sid;
   ELSIF iteration=4 THEN DELETE FROM auth.sessions WHERE id=sid;
   ELSIF iteration=5 THEN UPDATE auth.users SET banned_until=clock_timestamp()+interval '1 hour' WHERE id=uid;
   ELSIF iteration=6 THEN UPDATE fountain_private.entities SET data=jsonb_set(data,'{active}','false') WHERE workspace_id=ws AND kind='member' AND id='member';
   ELSIF iteration=7 THEN UPDATE fountain_private.entities SET data=jsonb_set(data,'{role}','"forged-admin"') WHERE workspace_id=ws AND kind='member' AND id='member';
   ELSE DELETE FROM fountain_private.identity_mapping WHERE workspace_id=ws AND auth_user_id=uid;END IF;
   BEGIN PERFORM public.fountain_cloud_store_attachment_references(ctx,identity);RAISE EXCEPTION 'Stale Auth/member state accepted: %',iteration;EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
   RAISE EXCEPTION USING ERRCODE='Z0002',MESSAGE='rollback auth fixture branch';
  EXCEPTION WHEN SQLSTATE 'Z0002' THEN NULL;END;
 END LOOP;
 BEGIN PERFORM public.fountain_cloud_store_attachment_references(ctx||'{"workspaceId":"wrong-workspace"}',identity);RAISE EXCEPTION 'Cross workspace context accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 FOREACH role_name IN ARRAY ARRAY['memberId','authSessionId','sessionHash','cacheBinding'] LOOP
  variant:=jsonb_set(ctx,ARRAY[role_name],to_jsonb(CASE role_name WHEN 'memberId' THEN 'wrong-member' WHEN 'authSessionId' THEN gen_random_uuid()::text WHEN 'sessionHash' THEN repeat('f',64) ELSE repeat('f',32) END));
  BEGIN PERFORM public.fountain_cloud_store_attachment_references(variant,identity);RAISE EXCEPTION 'Mismatched Auth context accepted';EXCEPTION WHEN SQLSTATE 'PT401' THEN NULL;END;
 END LOOP;
 BEGIN PERFORM public.fountain_cloud_store_attachment_references(ctx||'{"extra":"untrusted"}',identity);RAISE EXCEPTION 'Extra context field accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM public.fountain_cloud_store_attachment_references(NULL,identity);RAISE EXCEPTION 'NULL context accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','fountain_backend'] LOOP
  EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name);
  BEGIN PERFORM public.fountain_cloud_store_attachment_references(ctx,identity);RAISE EXCEPTION 'Forbidden SQL role invoked metadata RPC';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  EXECUTE 'RESET ROLE';
 END LOOP;
 IF has_function_privilege('anon','fountain_private.attachment_referenced(text,text)','EXECUTE') OR has_function_privilege('authenticated','fountain_private.attachment_referenced(text,text)','EXECUTE') OR has_function_privilege('service_role','fountain_private.attachment_referenced(text,text)','EXECUTE') THEN RAISE EXCEPTION 'Private scalar grants widened';END IF;
END $references$;
