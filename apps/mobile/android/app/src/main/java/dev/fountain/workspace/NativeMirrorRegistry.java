package dev.fountain.workspace;

import android.database.Cursor;
import com.getcapacitor.JSObject;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** OS-private immutable reader locations. It neither reads nor accepts IDB bytes. */
final class NativeMirrorRegistry {
    static final class Conflict extends Exception {}
    private static final SecureRandom RANDOM=new SecureRandom();
    private final NativeOutbox host;
    NativeMirrorRegistry(NativeOutbox host){this.host=host;}
    private static final class Pair {
        final String kind,ref;
        Pair(String kind,String ref){NativeMirrorPolicy.pair(kind,ref);this.kind=kind;this.ref=ref;}
        JSONObject json()throws Exception{return new JSONObject().put("kind",kind).put("ref",ref);}
    }
    private static String opaque(){byte[] bytes=new byte[32];RANDOM.nextBytes(bytes);StringBuilder value=new StringBuilder("v1-");for(byte b:bytes)value.append("0123456789abcdef".charAt((b&255)>>>4)).append("0123456789abcdef".charAt(b&15));return value.toString();}
    private long revision(){try(Cursor c=host.db.rawQuery("SELECT revision FROM native_mirror_state_v1 WHERE singleton=1",null)){NativePolicy.require(c.moveToFirst());return c.getLong(0);}}
    private void changed(){host.db.execSQL("UPDATE native_mirror_state_v1 SET revision=revision+1 WHERE singleton=1");}
    private Pair assigned(String profile,String incarnation,String actor)throws Exception {
        try(Cursor c=host.db.rawQuery("SELECT kind,ref,actor FROM native_profile_mirrors_v1 WHERE profile_id=? AND incarnation=?",new String[]{profile,incarnation})){
            if(!c.moveToFirst())return null;NativePolicy.require(actor.equals(c.getString(2)));return new Pair(c.getString(0),c.getString(1));
        }
    }
    private boolean baseAssigned(){try(Cursor c=host.db.rawQuery("SELECT 1 FROM native_profile_mirrors_v1 WHERE ref='base'",null)){return c.moveToFirst();}}
    private Pair assign(String profile,String incarnation,String actor,boolean base)throws Exception {
        Pair pair=new Pair(base?"base":"profile",base?"base":opaque());
        host.db.execSQL("INSERT INTO native_profile_mirrors_v1(profile_id,incarnation,actor,kind,ref) VALUES(?,?,?,?,?)",new Object[]{profile,incarnation,actor,pair.kind,pair.ref});changed();return pair;
    }
    private Pair resolve(String profile,String incarnation,String actor)throws Exception {
        Pair pair=assigned(profile,incarnation,actor);if(pair!=null)return pair;
        return baseAssigned()?assign(profile,incarnation,actor,false):new Pair("base","base");
    }
    JSObject call(JSONObject input,long generation,JSONObject grant,long epoch,boolean ready)throws Exception {
        String profile=grant.getString("profileId"),actor=OutboxPolicy.actorPrefix(host.origin,profile);
        NativePolicy.require(actor!=null);
        String incarnation=OutboxPolicy.hash(grant.getString("session_ref")+"|"+grant.getJSONObject("session").getString("account_binding"));
        String action=input.getString("action");
        host.db.beginTransaction();try {
            Pair pair;
            if(action.equals("confirm-base")){
                if(!ready)throw new NativeOutbox.AccessRequired();
                pair=assigned(profile,incarnation,actor);
                if(pair!=null&&!pair.kind.equals("base"))throw new Conflict();
                if(pair==null){if(baseAssigned())throw new Conflict();pair=assign(profile,incarnation,actor,true);}
            }else if(action.equals("separate")){
                pair=assigned(profile,incarnation,actor);
                if(pair!=null&&pair.kind.equals("base"))throw new Conflict();
                if(pair==null){if(baseAssigned())throw new Conflict();pair=assign(profile,incarnation,actor,false);}
            }else pair=resolve(profile,incarnation,actor);
            String disposition=pair.kind.equals("base")?(baseAssigned()?"current":"candidate"):(baseAssigned()?"preserved":"unresolved");
            JSObject reply=new JSObject();reply.put("generation",generation);reply.put("version",1);reply.put("profileId",profile);reply.put("epoch",epoch);reply.put("pair",pair.json());reply.put("baseDisposition",disposition);
            if(action.equals("catalog"))catalog(input,reply,profile,incarnation,actor,pair,epoch,grant.getLong("validUntil"));
            host.db.setTransactionSuccessful();return reply;
        }finally{host.db.endTransaction();}
    }
    private static final class Location {
        final JSONObject entry;final int prefix;final long sequence;
        Location(Pair pair,String relation,boolean unresolved,int prefix,long sequence)throws Exception{entry=new JSONObject().put("pair",pair.json()).put("relation",relation).put("unresolved",unresolved);this.prefix=prefix;this.sequence=sequence;}
    }
    private void catalog(JSONObject input,JSObject reply,String profile,String incarnation,String actor,Pair current,long epoch,long until)throws Exception {
        int limit=input.has("limit")?(int)OutboxPolicy.integer(input.opt("limit"),1,100):20;
        int position=0;long after=0,revision=revision();
        if(input.has("cursor")&&!input.isNull("cursor")){
            Object supplied=input.opt("cursor");NativePolicy.require(supplied instanceof String);NativeMirrorPolicy.cursor((String)supplied);
            try(Cursor c=host.db.rawQuery("SELECT token,epoch,revision,prefix_position,after_sequence,expires_at FROM native_mirror_cursors_v1 WHERE profile_id=? AND incarnation=?",new String[]{profile,incarnation})){
                NativePolicy.require(c.moveToFirst()&&supplied.equals(c.getString(0))&&epoch==c.getLong(1)&&revision==c.getLong(2)&&c.getLong(5)>System.currentTimeMillis());position=c.getInt(3);after=c.getLong(4);
            }
        }
        List<Location> prefix=new ArrayList<>();prefix.add(new Location(current,"current",current.kind.equals("base"),1,0));
        if(!current.kind.equals("base"))prefix.add(new Location(new Pair("base","base"),"preserved",true,2,0));
        NativePolicy.require(position>=0&&position<=prefix.size()&&after>=0);
        List<Location> page=new ArrayList<>();for(int i=position;i<prefix.size()&&page.size()<=limit;i++)page.add(prefix.get(i));
        if(page.size()<=limit){int remaining=limit+1-page.size();try(Cursor c=host.db.rawQuery("SELECT sequence,ref FROM native_profile_mirrors_v1 WHERE actor=? AND kind='profile' AND ref<>? AND sequence>? ORDER BY sequence LIMIT ?",new String[]{actor,current.ref,Long.toString(after),Integer.toString(remaining)})){
            while(c.moveToNext())page.add(new Location(new Pair("profile",c.getString(1)),"recovery",true,prefix.size(),c.getLong(0)));
        }}
        JSONArray entries=new JSONArray();for(int i=0;i<Math.min(limit,page.size());i++)entries.put(page.get(i).entry);reply.put("entries",entries);
        if(page.size()>limit){Location last=page.get(limit-1);String next=opaque();host.db.execSQL("INSERT OR REPLACE INTO native_mirror_cursors_v1 VALUES(?,?,?,?,?,?,?,?)",new Object[]{profile,incarnation,next,epoch,revision,last.prefix,last.sequence,Math.min(until,System.currentTimeMillis()+300000)});reply.put("next",next);}
        else reply.put("next",JSONObject.NULL);
    }
}
