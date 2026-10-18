package dev.fountain.workspace;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Location metadata only; never a renderer byte digest or business authority. */
final class NativeMirrorPolicy {
    static final Set<String> ACTIONS=new HashSet<>(Arrays.asList("resolve","confirm-base","separate","catalog"));
    static void fields(Set<String> names,String action) {
        NativePolicy.require(ACTIONS.contains(action));
        Set<String> required=new HashSet<>(Arrays.asList("version","generation","action","expectedProfileId","expectedEpoch"));
        NativePolicy.require(names.containsAll(required));
        if(action.equals("catalog")){required.add("limit");required.add("cursor");}
        NativePolicy.require(required.containsAll(names));
    }
    static void pair(String kind,String ref) {
        NativePolicy.require(kind!=null&&ref!=null&&(kind.equals("base")&&ref.equals("base")||kind.equals("profile")&&ref.matches("v1-[a-f0-9]{64}")));
    }
    static void cursor(String value) { NativePolicy.require(value!=null&&value.matches("v1-[a-f0-9]{64}")); }
    private NativeMirrorPolicy() {}
}
