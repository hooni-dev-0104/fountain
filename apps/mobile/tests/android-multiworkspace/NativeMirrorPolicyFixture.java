package dev.fountain.workspace;
import java.util.*;
/** Pure DTO/reference checks; private authority is exercised by SDK SQLite tests. */
public final class NativeMirrorPolicyFixture {
 static int checks;
 static void yes(boolean value){checks++;if(!value)throw new AssertionError("Mirror policy check "+checks);}
 static void rejected(Runnable run){checks++;try{run.run();throw new AssertionError("Forged mirror envelope accepted");}catch(IllegalArgumentException expected){}}
 public static void main(String[] args){
  Set<String> required=new HashSet<>(Arrays.asList("version","generation","action","expectedProfileId","expectedEpoch"));
  for(String action:NativeMirrorPolicy.ACTIONS){NativeMirrorPolicy.fields(required,action);yes(true);}
  for(String key:required){Set<String> missing=new HashSet<>(required);missing.remove(key);rejected(()->NativeMirrorPolicy.fields(missing,"resolve"));}
  for(String key:Arrays.asList("pair","ref","actor","owner","parentHash","digest","id","workspaceEpoch","entries","fingerprint")){Set<String> forged=new HashSet<>(required);forged.add(key);rejected(()->NativeMirrorPolicy.fields(forged,"resolve"));}
  for(String optional:Arrays.asList("limit","cursor")){Set<String> catalog=new HashSet<>(required);catalog.add(optional);NativeMirrorPolicy.fields(catalog,"catalog");yes(true);rejected(()->NativeMirrorPolicy.fields(catalog,"resolve"));}
  rejected(()->NativeMirrorPolicy.fields(required,"adopt"));rejected(()->NativeMirrorPolicy.fields(required,null));
  String opaque="v1-"+String.join("",Collections.nCopies(64,"a"));NativeMirrorPolicy.pair("base","base");yes(true);NativeMirrorPolicy.pair("profile",opaque);yes(true);NativeMirrorPolicy.cursor(opaque);yes(true);
  for(String ref:Arrays.asList("base",opaque.toUpperCase(Locale.ROOT),"v1-00",opaque+"/x","https://arbitrary.invalid/db",opaque+"%00")){rejected(()->NativeMirrorPolicy.pair("profile",ref));rejected(()->NativeMirrorPolicy.cursor(ref));}
  rejected(()->NativeMirrorPolicy.pair("base",opaque));rejected(()->NativeMirrorPolicy.pair("other",opaque));rejected(()->NativeMirrorPolicy.pair(null,"base"));
  System.out.println("PASS Android native mirror DTO/reference policy: "+checks+" checks (no native authority claim)");
 }
}
