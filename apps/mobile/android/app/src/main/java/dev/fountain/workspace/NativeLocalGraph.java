package dev.fountain.workspace;

import android.database.Cursor;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Whole final-overlay closure, evaluated only against native observed authority. */
final class NativeLocalGraph {
    static final class InvalidResource extends IllegalArgumentException {
        final String resource;
        final String operation;
        InvalidResource(String resource, Exception cause) { this(resource, null, cause); }
        InvalidResource(String resource, String operation, Exception cause) { super("Invalid local dependency closure", cause); this.resource = resource; this.operation = operation; }
    }
    private final NativeOutbox host;
    private final JSONObject grant, ledger, workspace;
    private final String profile;
    final Map<String, JSONObject> mutations = new HashMap<>(), pages = new HashMap<>(), snapshots = new HashMap<>();
    private final Map<String, String> pageCreates = new HashMap<>(), rowCreates = new HashMap<>();
    private final Set<String> rowTargets=new HashSet<>();
    private final Map<String, Set<String>> edges = new HashMap<>();
    private final Set<String> checked = new HashSet<>();
    NativeLocalGraph(NativeOutbox host, JSONObject grant) throws Exception {
        this(host, grant, null);
    }
    NativeLocalGraph(NativeOutbox host, JSONObject grant, String planId) throws Exception {
        this.host = host; this.grant = grant; profile = grant.getString("profileId");
        String raw = host.get("resource_proofs"); ledger = raw == null ? null : new JSONObject(raw);
        workspace = ledger == null ? null : ledger.getJSONObject("entries").optJSONObject("workspace:workspace");
        long total = 0; int count = 0; Set<String> snapshotTargets = new HashSet<>();
        String query = planId == null ? "SELECT bucket,rowid,resource_key,length(payload) FROM records WHERE mode='active' AND profile_id=? AND bucket IN ('mutations','localPages','snapshots') ORDER BY CASE WHEN bucket='snapshots' THEN 1 ELSE 0 END"
            : "SELECT bucket,rowid,resource_key,length(payload) FROM reconcile_rows WHERE phase='output' AND profile_id=? AND plan_id=? AND bucket IN ('mutations','localPages','snapshots') ORDER BY CASE WHEN bucket='snapshots' THEN 1 ELSE 0 END";
        try (Cursor c = host.db.rawQuery(query, planId == null ? new String[]{profile} : new String[]{profile, planId})) {
            while (c.moveToNext()) {
                int size = c.getInt(3); total += size; NativePolicy.require(++count <= 100000 && size > 0 && size <= OutboxPolicy.RECORD && total <= OutboxPolicy.TRANSACTION);
                String bucket = c.getString(0), resource = c.getString(2); NativePolicy.require(OutboxPolicy.resource(profile, resource));
                if (bucket.equals("snapshots") && !snapshotTargets.contains(resourceID(resource))) continue;
                byte[] bytes = host.payload(planId == null ? "records" : "reconcile_rows", c.getLong(1), size);
                JSONObject value = new JSONObject(OutboxPolicy.utf8(bytes)); NativePolicy.require(profile.equals(value.getString("profileId")));
                if (bucket.equals("mutations")) {
                    JSONObject operation = value.getJSONObject("operation"); String id = OutboxPolicy.id(value.getString("id"));
                    NativePolicy.require(id.equals(operation.getString("id")) && !mutations.containsKey(id)); mutations.put(id, value); if ("page.create".equals(operation.opt("kind"))) snapshotTargets.add(identity(operation.opt("target_id")));
                } else if (bucket.equals("localPages") && value.getJSONObject("metadata").opt("localOnly") == Boolean.TRUE) {
                    String id = resourceID(resource); NativePolicy.require(!pages.containsKey(id)); pages.put(id, value); snapshotTargets.add(id);
                } else if (bucket.equals("snapshots")) snapshots.put(resourceID(resource), value.getJSONObject("snapshot"));
            }
        }
        for (Map.Entry<String, JSONObject> item : mutations.entrySet()) {
            try {
            JSONObject operation = item.getValue().getJSONObject("operation"); String kind = operation.getString("kind"), target = identity(operation.opt("target_id"));
            NativePolicy.require(Arrays.asList("page.create", "page.patch", "row.create", "row.patch", "row.delete").contains(kind));
            String expected = profile + (kind.startsWith("row.") ? "|database|" + OutboxPolicy.encode(identity(operation.opt("database_id"))) : "|" + OutboxPolicy.encode(target));
            NativePolicy.require(expected.equals(item.getValue().getString("resourceKey")));
            Set<String> dependencies = new HashSet<>(); JSONArray explicit = operation.optJSONArray("depends_on");
            if (operation.has("depends_on")) NativePolicy.require(explicit != null && explicit.length() <= 50);
            if (explicit != null) for (int i = 0; i < explicit.length(); i++) NativePolicy.require(dependencies.add(OutboxPolicy.id(OutboxPolicy.text(explicit.get(i), 160))));
            JSONObject bases = operation.optJSONObject("base_rows");
            if (bases != null) { Iterator<String> keys = bases.keys(); while (keys.hasNext()) { JSONObject base = bases.getJSONObject(keys.next()); if (base.has("after_operation")) dependencies.add(OutboxPolicy.id(OutboxPolicy.text(base.get("after_operation"), 160))); } }
            edges.put(item.getKey(), dependencies);
            if (kind.equals("page.create")) NativePolicy.require(pageCreates.put(target, item.getKey()) == null);
            if (kind.equals("row.create")) NativePolicy.require(rowTargets.add(target)&&rowCreates.put(identity(operation.opt("database_id")) + "\u0000" + target, item.getKey()) == null);
            } catch (IllegalArgumentException | org.json.JSONException invalid) { throw new InvalidResource(item.getValue().getString("resourceKey"), item.getKey(), invalid); }
        }
        validateDAG();
        for (String id : pages.keySet()) { try { page(id); } catch (IllegalArgumentException | org.json.JSONException invalid) { throw new InvalidResource(profile + "|" + OutboxPolicy.encode(id), invalid); } }
        for (Map.Entry<String, JSONObject> item : mutations.entrySet()) {
            try { validateOperation(item.getKey(), item.getValue().getJSONObject("operation")); }
            catch (IllegalArgumentException | org.json.JSONException invalid) { throw new InvalidResource(item.getValue().getString("resourceKey"), item.getKey(), invalid); }
        }
    }
    private String identity(Object value) { return OutboxPolicy.text(value, 1000); }
    private String resourceID(String resource) throws Exception {
        String encoded = resource.substring(resource.lastIndexOf('|') + 1), id = java.net.URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8");
        NativePolicy.require(OutboxPolicy.encode(id).equals(encoded)); return id;
    }
    private void validateDAG() throws Exception {
        Map<String,Integer> remaining=new HashMap<>();Map<String,List<String>> successors=new HashMap<>();ArrayDeque<String> ready=new ArrayDeque<>();
        for(String id:mutations.keySet()){
            Set<String> dependencies=edges.get(id);int pending=0;
            for(String dependency:dependencies){if(dependency.equals(id)||!mutations.containsKey(dependency)&&host.appliedDependency(grant,dependency)==null)throw new InvalidResource(mutations.get(id).getString("resourceKey"),id,new IllegalArgumentException());if(mutations.containsKey(dependency)){pending++;successors.computeIfAbsent(dependency,key->new ArrayList<>()).add(id);}}
            remaining.put(id,pending);if(pending==0)ready.add(id);
        }
        int count=0;while(!ready.isEmpty()){String id=ready.removeFirst();count++;for(String successor:successors.getOrDefault(id,java.util.Collections.emptyList())){int left=remaining.get(successor)-1;remaining.put(successor,left);if(left==0)ready.add(successor);}}
        if(count!=mutations.size())for(String id:remaining.keySet())if(remaining.get(id)>0)throw new InvalidResource(mutations.get(id).getString("resourceKey"),id,new IllegalArgumentException());
    }
    private boolean depends(String id, String predecessor, Set<String> seen) {
        ArrayDeque<String> pending=new ArrayDeque<>();pending.add(id);
        while(!pending.isEmpty()){String current=pending.removeFirst();if(current.equals(predecessor))return true;if(!seen.add(current))continue;pending.addAll(edges.getOrDefault(current,java.util.Collections.emptySet()));}return false;
    }
    private JSONObject observed(String kind, String id, int needed) throws Exception {
        if (ledger == null || workspace == null || workspace.opt("denied") == Boolean.TRUE) return null;
        JSONObject value = ledger.getJSONObject("entries").optJSONObject(kind + ":" + OutboxPolicy.encode(id));
        if (value == null || value.opt("denied") == Boolean.TRUE || value.getLong("accessRevision") != ledger.getLong("maxAccessRevision") || value.getLong("dataRevision") != ledger.getLong("maxDataRevision")
            || !OutboxPolicy.live(System.currentTimeMillis(), value.getLong("validUntil"), grant.getLong("validUntil"))
            || !OutboxPolicy.capability(value.getLong("accessLevel"), needed, value.opt("locked") == Boolean.TRUE, value.opt("archived") == Boolean.TRUE)) return null;
        return value;
    }
    JSONObject page(String id) throws Exception {
        if (!pages.containsKey(id)) return observed("page", id, 3);
        List<String> chain = new ArrayList<>(); Set<String> seen = new HashSet<>(); String current = id;
        while (current != null && pages.containsKey(current) && !checked.contains(current)) {
            NativePolicy.require(seen.add(current)); chain.add(current);
            JSONObject local = pages.get(current); String create = pageCreates.get(current); NativePolicy.require(create != null);
            JSONObject operation = mutations.get(create).getJSONObject("operation"), metadata = local.getJSONObject("metadata"), body = operation.getJSONObject("body"), page = metadata.getJSONObject("page"), snapshot = snapshots.get(current);
            String epoch = identity(metadata.opt("initial_epoch"));
            NativePolicy.require(create.equals(metadata.getString("create_operation_id")) && current.equals(identity(page.opt("id"))) && current.equals(identity(body.opt("id")))
                && epoch.equals(identity(operation.opt("document_epoch"))) && snapshot != null && epoch.equals(identity(snapshot.opt("epoch")))
                && current.equals(snapshot.getJSONObject("page").getString("id")));
            host.envelope(snapshot, profile); JSONObject state = snapshot.getJSONObject("state");
            NativePolicy.require(page.opt("locked") == Boolean.FALSE && page.opt("archived") == Boolean.FALSE);
            if(serverKnown(current)){
                JSONObject actual=observed("page",current,3);NativePolicy.require(actual!=null&&epoch.equals(actual.opt("epoch"))&&snapshot.getLong("seq")==actual.getLong("seq")&&snapshot.getLong("access_revision")==actual.getLong("accessRevision")&&snapshot.getLong("data_revision")==actual.getLong("dataRevision"));
            }else{
                NativePolicy.require(OutboxPolicy.integer(snapshot.opt("seq"),0,OutboxPolicy.SAFE-1)==0&&state.getLong("version")==1&&state.getLong("max_clock")==0&&state.getJSONObject("blocks").length()==0&&state.getJSONObject("seen").length()==0&&snapshot.getJSONArray("blocks").length()==0);
                NativePolicy.require(snapshot.getLong("access_level")==4&&snapshot.getJSONObject("page").getLong("access_level")==4);
                for(String field:Arrays.asList("parent_id","teamspace_id"))NativePolicy.require(ObjectsEqual(page.opt(field),snapshot.getJSONObject("page").opt(field)));
            }
            for (String field : Arrays.asList("parent_id", "teamspace_id")) NativePolicy.require(ObjectsEqual(body.opt(field), page.opt(field)));
            String parent = body.isNull("parent_id") ? null : identity(body.opt("parent_id"));
            if (parent == null) {
                NativePolicy.require(!"guest".equals(grant.getString("role")) && workspace != null && workspace.opt("denied") != Boolean.TRUE
                    && workspace.getLong("accessRevision") == ledger.getLong("maxAccessRevision") && workspace.getLong("dataRevision") == ledger.getLong("maxDataRevision")
                    && OutboxPolicy.live(System.currentTimeMillis(), workspace.getLong("validUntil"), grant.getLong("validUntil")));
                if (!body.isNull("teamspace_id")) NativePolicy.require(OutboxPolicy.integer(workspace.getJSONObject("teamspaces").opt(identity(body.opt("teamspace_id"))), 3, 4) >= 3);
            } else if (!pages.containsKey(parent)) NativePolicy.require(observed("page", parent, 3) != null);
            current = parent;
        }
        for (int i = chain.size() - 1; i >= 0; i--) {
            String child = chain.get(i), create = pageCreates.get(child); JSONObject body = mutations.get(create).getJSONObject("operation").getJSONObject("body");
            String parent = body.isNull("parent_id") ? null : identity(body.opt("parent_id"));
            if (parent != null) {
                JSONObject permitted = pages.containsKey(parent) ? pageProof(parent) : observed("page", parent, 3); NativePolicy.require(permitted != null);
                Object space = pages.containsKey(parent) && !serverKnown(parent) ? pages.get(parent).getJSONObject("metadata").getJSONObject("page").opt("teamspace_id") : permitted.opt("teamspaceId");
                NativePolicy.require(ObjectsEqual(body.opt("teamspace_id"), space));
                if (pages.containsKey(parent)) NativePolicy.require(depends(create, pageCreates.get(parent), new HashSet<>()));
            }
            checked.add(child);
        }
        return pageProof(id);
    }
    private boolean serverKnown(String id)throws Exception{return host.serverObserved(grant.getJSONObject("session").getString("workspace_id"),id)||ledger!=null&&(ledger.getJSONObject("entries").has("page:"+OutboxPolicy.encode(id))||workspace!=null&&workspace.optJSONObject("pages")!=null&&workspace.getJSONObject("pages").has(id));}
    private JSONObject pageProof(String id)throws Exception{return serverKnown(id)?observed("page",id,3):localProof(id);}
    private static boolean ObjectsEqual(Object left, Object right) { return left == null || left == JSONObject.NULL ? right == null || right == JSONObject.NULL : left.equals(right); }
    private JSONObject localProof(String id) throws Exception {
        return new JSONObject().put("profileId", profile).put("kind", "page").put("id", id).put("accessRevision", ledger.getLong("maxAccessRevision")).put("dataRevision", ledger.getLong("maxDataRevision"))
            .put("accessLevel", 4).put("locked", false).put("archived", false).put("epoch", pages.get(id).getJSONObject("metadata").getString("initial_epoch")).put("seq", 0).put("validUntil", grant.getLong("validUntil"));
    }
    boolean local(String id) { return pages.containsKey(id); }
    boolean newlyLocal(String id)throws Exception{return pages.containsKey(id)&&!serverKnown(id);}
    boolean row(String database, String id) { return rowCreates.containsKey(database + "\u0000" + id); }
    boolean anyLocalRow(String id){return rowTargets.contains(id);}
    private void rowReference(String operation, String database, String id, int needed) throws Exception {
        String local = rowCreates.get(database + "\u0000" + id);
        if (local != null) { NativePolicy.require(depends(operation, local, new HashSet<>())); return; }
        JSONObject proof = observed("database", database, 1), row = proof == null ? null : proof.getJSONObject("rows").optJSONObject(id);
        NativePolicy.require(row != null && row.getLong("accessLevel") >= needed);
    }
    private void references(String id, String database, JSONObject operation, JSONObject body) throws Exception {
        if (!body.isNull("parent_row_id")) rowReference(id, database, identity(body.opt("parent_row_id")), 1);
        JSONArray dependencies = body.optJSONArray("depends_on");
        if (body.has("depends_on")) NativePolicy.require(dependencies != null && dependencies.length() <= 1000);
        if (dependencies != null) for (int i = 0; i < dependencies.length(); i++) rowReference(id, database, identity(dependencies.get(i)), 1);
        JSONObject values = body.optJSONObject("properties"), proof = observed("database", database, 1);
        if (values != null) { NativePolicy.require(proof != null); Iterator<String> keys = values.keys(); while (keys.hasNext()) {
            String property = keys.next(); JSONObject schema = proof.getJSONObject("schema").optJSONObject(property); NativePolicy.require(schema != null && !Arrays.asList("formula", "rollup").contains(schema.getString("type")));
            if (schema.getString("type").equals("relation") && !values.isNull(property)) {
                JSONArray rows = values.getJSONArray(property); NativePolicy.require(rows.length() <= 1000);
                for (int i = 0; i < rows.length(); i++) {
                    if(!schema.isNull("database_id"))rowReference(id,schema.getString("database_id"),identity(rows.get(i)),1);
                    else{String target=identity(rows.get(i));boolean found=false;for(String candidate:rowCreates.keySet())if(candidate.endsWith("\u0000"+target)){NativePolicy.require(depends(id,rowCreates.get(candidate),new HashSet<>()));found=true;}
                        Iterator<String> entryKeys=ledger.getJSONObject("entries").keys();while(entryKeys.hasNext()){JSONObject entry=ledger.getJSONObject("entries").getJSONObject(entryKeys.next());if(!"database".equals(entry.opt("kind")))continue;JSONObject fresh=observed("database",entry.getString("id"),1);if(fresh!=null&&fresh.getJSONObject("rows").optJSONObject(target)!=null&&fresh.getJSONObject("rows").getJSONObject(target).getLong("accessLevel")>=1)found=true;}
                        NativePolicy.require(found);
                    }
                }
            }
        } }
    }
    private void validateOperation(String id, JSONObject operation) throws Exception {
        String kind = operation.getString("kind"), target = identity(operation.opt("target_id")); JSONObject body = operation.getJSONObject("body");
        if (kind.startsWith("page.")) {
            NativePolicy.require(page(target) != null);
            if(kind.equals("page.create")&&!pages.containsKey(target)){NativePolicy.require(host.appliedSync(grant,operation)!=null&&snapshots.containsKey(target)&&operation.getString("document_epoch").equals(snapshots.get(target).getString("epoch")));}
            if (kind.equals("page.patch") && pages.containsKey(target)) NativePolicy.require(depends(id, pageCreates.get(target), new HashSet<>()));
            return;
        }
        String database = identity(operation.opt("database_id")); JSONObject proof = observed("database", database, 1); NativePolicy.require(proof != null);
        if (kind.equals("row.create")) {
            NativePolicy.require(target.equals(identity(body.opt("id"))));
            if(proof.getJSONObject("rows").has(target))NativePolicy.require(host.appliedSync(grant,operation)!=null&&proof.getJSONObject("rows").getJSONObject(target).getLong("accessLevel")>=3);
            else NativePolicy.require(proof.opt("canCreateRow")==Boolean.TRUE);
        } else rowReference(id, database, target, 3);
        references(id, database, operation, body);
        JSONObject base = operation.optJSONObject("base");
        if(base!=null){JSONObject basis=new JSONObject();if(base.optJSONObject("properties")!=null)basis.put("properties",base.getJSONObject("properties"));JSONObject fields=base.optJSONObject("fields");if(fields!=null)for(String field:Arrays.asList("parent_row_id","depends_on"))if(fields.has(field))basis.put(field,fields.get(field));references(id,database,operation,basis);}
        if (base != null && base.optJSONObject("schema") != null) { Iterator<String> keys = base.getJSONObject("schema").keys(); while (keys.hasNext()) { String property = keys.next(); NativePolicy.require(proof.getJSONObject("schema").has(property) && host.canonical(base.getJSONObject("schema").get(property), false).equals(host.canonical(proof.getJSONObject("schema").get(property), false))); } }
        JSONObject baseRows = operation.optJSONObject("base_rows"); if (baseRows != null) { Iterator<String> rows = baseRows.keys(); while (rows.hasNext()) {
            String row=rows.next();rowReference(id,database,row,3);JSONObject rowBase=baseRows.getJSONObject(row);
            if(rowBase.has("after_operation")){String dependency=rowBase.getString("after_operation");JSONObject previous=mutations.containsKey(dependency)?mutations.get(dependency).getJSONObject("operation"):host.appliedDependency(grant,dependency);
                NativePolicy.require(previous!=null&&Arrays.asList("row.create","row.patch").contains(previous.getString("kind"))&&database.equals(previous.getString("database_id"))&&row.equals(previous.getString("target_id")));
            }
        } }
    }
}
