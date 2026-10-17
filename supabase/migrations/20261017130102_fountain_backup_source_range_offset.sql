-- PostgreSQL's bytea substr overload takes an integer byte offset. A private
-- resumable cursor uses bigint; validate it against the bounded row first.
-- Keep the reviewed Auth, lease, CAS, source and publication code byte-identical.
DO $patch$
DECLARE definition text;before text:='ELSE v_raw:=substr(v_item.raw,v_off+1,v_wanted);';after text:='ELSE IF v_item.raw IS NULL OR v_off>octet_length(v_item.raw) THEN RAISE EXCEPTION ''Private source byte offset is outside its row'' USING ERRCODE=''PT503'';END IF;v_raw:=substr(v_item.raw,v_off::integer+1,v_wanted);';
BEGIN
 definition:=pg_get_functiondef('fountain_cloud.backup_jobs_rpc(jsonb,text,jsonb)'::regprocedure);
 IF encode(sha256(convert_to(definition,'UTF8')),'hex')<>'2ff46a0f09c9b840315a62b4d09f5363e286db2eec31352d95124014a33111e2'
  OR length(definition)-length(replace(definition,before,''))<>length(before) THEN
  RAISE EXCEPTION 'Backup range patch requires its exact reviewed predecessor';
 END IF;
 EXECUTE replace(definition,before,after);
END $patch$;
