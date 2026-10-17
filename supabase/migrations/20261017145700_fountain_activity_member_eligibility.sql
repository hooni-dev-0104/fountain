-- Preserve minimal legacy member writes without minting a trusted episode.
-- Eligibility matches the canonical actor predicate; role/name/email changes
-- among eligible members preserve identity, while ineligibility closes it.
CREATE OR REPLACE FUNCTION fountain_private.activity_lifecycle_event() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $f$
DECLARE ws text;member text;before_active boolean;after_active boolean;previous text;kind text;stamp text;
BEGIN
 ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF NOT EXISTS(SELECT 1 FROM fountain_private.activity_runtime WHERE workspace_id=ws AND singleton=1) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NOT pg_try_advisory_xact_lock(('x'||substr(encode(sha256(convert_to('fountain:workspace:'||ws,'UTF8')),'hex'),1,16))::bit(64)::bigint) THEN RAISE EXCEPTION 'Activity identity transition is busy' USING ERRCODE='PT409';END IF;
 previous:=current_setting('fountain.activity_write',true);PERFORM set_config('fountain.activity_write',ws,true);stamp:=fountain_private.activity_now();
 IF TG_TABLE_NAME='entities' THEN
  kind:=CASE WHEN TG_OP='DELETE' THEN OLD.kind ELSE NEW.kind END;member:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  IF kind='member' THEN
   before_active:=COALESCE(TG_OP<>'INSERT' AND OLD.kind='member' AND OLD.data->>'id'=OLD.id AND COALESCE(OLD.data->'active','true'::jsonb)='true'::jsonb AND OLD.data->>'role' IN('owner','admin','member','guest'),false);
   after_active:=COALESCE(TG_OP<>'DELETE' AND NEW.kind='member' AND NEW.data->>'id'=NEW.id AND COALESCE(NEW.data->'active','true'::jsonb)='true'::jsonb AND NEW.data->>'role' IN('owner','admin','member','guest'),false);
   IF NOT after_active THEN PERFORM fountain_private.activity_close_member(ws,member,CASE WHEN TG_OP='DELETE' THEN 'deleted' ELSE 'inactive' END,stamp);
   ELSIF NOT before_active THEN
    PERFORM fountain_private.activity_ensure_member(ws,member);
    IF EXISTS(SELECT 1 FROM fountain_private.entities e WHERE e.workspace_id=ws AND e.kind='credential' AND e.id=member) THEN PERFORM fountain_private.activity_ensure_account(ws,member,'password');END IF;
    IF EXISTS(SELECT 1 FROM fountain_private.identity_mapping m WHERE m.workspace_id=ws AND m.member_id=member) THEN PERFORM fountain_private.activity_ensure_account(ws,member,'supabase');END IF;
   END IF;
  ELSIF kind='credential' THEN
   IF TG_OP='DELETE' THEN PERFORM fountain_private.activity_close_account(ws,member,'password','credential_removed',stamp);
   ELSIF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM fountain_private.activity_current_members c JOIN fountain_private.entities e ON e.workspace_id=c.workspace_id AND e.kind='member' AND e.id=c.member_id WHERE c.workspace_id=ws AND c.member_id=member AND e.data->>'id'=e.id AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND e.data->>'role' IN('owner','admin','member','guest')) THEN PERFORM fountain_private.activity_ensure_account(ws,member,'password');END IF;
  END IF;
 ELSIF TG_TABLE_NAME='identity_mapping' THEN
  IF TG_OP IN('UPDATE','DELETE') AND(TG_OP='DELETE' OR (OLD.workspace_id,OLD.member_id,OLD.auth_user_id) IS DISTINCT FROM(NEW.workspace_id,NEW.member_id,NEW.auth_user_id)) THEN PERFORM fountain_private.activity_close_account(OLD.workspace_id,OLD.member_id,'supabase','identity_changed',stamp);END IF;
  IF TG_OP IN('INSERT','UPDATE') AND(TG_OP='INSERT' OR (OLD.workspace_id,OLD.member_id,OLD.auth_user_id) IS DISTINCT FROM(NEW.workspace_id,NEW.member_id,NEW.auth_user_id)) AND EXISTS(SELECT 1 FROM fountain_private.activity_current_members c JOIN fountain_private.entities e ON e.workspace_id=c.workspace_id AND e.kind='member' AND e.id=c.member_id WHERE c.workspace_id=NEW.workspace_id AND c.member_id=NEW.member_id AND e.data->>'id'=e.id AND COALESCE(e.data->'active','true'::jsonb)='true'::jsonb AND e.data->>'role' IN('owner','admin','member','guest')) THEN PERFORM fountain_private.activity_ensure_account(NEW.workspace_id,NEW.member_id,'supabase');END IF;
 END IF;
 PERFORM set_config('fountain.activity_write',COALESCE(previous,''),true);
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $f$;

ALTER FUNCTION fountain_private.activity_lifecycle_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION fountain_private.activity_lifecycle_event() FROM PUBLIC,anon,authenticated,service_role,fountain_backend;
