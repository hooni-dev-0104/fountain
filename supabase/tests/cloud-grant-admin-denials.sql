-- Read-only privilege/context probes. No grant, identity or fixture is created.
DO $verify$
DECLARE n integer:=0; r text; f text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(r,'public.fountain_cloud_service_grant_admin(jsonb,text,jsonb)','EXECUTE') THEN
   RAISE EXCEPTION 'Client grant administration exposed';
  END IF;
  n:=n+1;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.fountain_cloud_service_grant_admin(jsonb,text,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'Server wrapper unavailable';
 END IF;
 n:=n+1;
 FOREACH f IN ARRAY ARRAY['fountain_cloud.service_grant_admin(jsonb,text,jsonb)','fountain_cloud.scim_grant_metadata(fountain_cloud.service_grants)'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'Private grant helper exposed';END IF;
  END LOOP;
  n:=n+1;
 END LOOP;
 BEGIN
  PERFORM public.fountain_cloud_service_grant_admin('{}','list','{"limit":50,"cursor":null}');
  RAISE EXCEPTION 'Missing identity accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN n:=n+1;
 END;
 RAISE NOTICE 'PASS % grant administration boundary checks',n;
END $verify$;
