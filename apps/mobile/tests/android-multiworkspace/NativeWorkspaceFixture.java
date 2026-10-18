package dev.fountain.workspace;
import java.util.*;
public final class NativeWorkspaceFixture {
    static int checks;
    static void yes(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
    static void denied(Runnable action){checks++;try{action.run();throw new AssertionError("unsafe path admitted "+checks);}catch(IllegalArgumentException expected){}}
    public static void main(String[] args) {
        String b="0123456789abcdef0123456789abcdef", prefix="/api/w/workspace-A/"+b;
        NativeWorkspacePolicy.Route route=NativeWorkspacePolicy.route(prefix+"/sync?cursor=abc");
        yes(route.workspace.equals("workspace-A"));yes(route.binding.equals(b));yes(route.logical.equals("/api/sync?cursor=abc"));yes(route.wire.equals(prefix+"/sync?cursor=abc"));
        for(String id:Arrays.asList("%EA%B0%80%EC%A1%B1%20%E6%96%87%E6%9B%B8%3F","space%20id","tag%23id","%F0%9F%8F%A0","safe!~*'()_-.","a%253Fb")) {
            String logical="/api/pages/"+id+"/collaboration?cursor=literal%25";
            NativeWorkspacePolicy.Route encoded=NativeWorkspacePolicy.route(prefix+logical.substring(4));
            yes(encoded.logical.equals(logical));yes(encoded.wire.equals(prefix+logical.substring(4)));
            yes(NativePolicy.apiUrl("https://fountain.invalid",encoded.wire).equals("https://fountain.invalid"+encoded.wire));
        }
        for(String id:Arrays.asList("%70","%ed%95%9C","%C0%AF","%ED%A0%80","%FF","%2F","%5C","%252F","%255c","%2E","%252e%252e","%00","%7F","%C2%80","%25C2%2580","%25ZZ","raw+id","raw:colon","가족"))denied(()->NativeWorkspacePolicy.route(prefix+"/pages/"+id));
        for(String head:Arrays.asList("%61ccount","%2561ccount","%6Frganization","%2577"))denied(()->NativeWorkspacePolicy.route(prefix+"/"+head+"/session"));
        for(String wire:Arrays.asList("/api/w/workspace%2DA/"+b+"/pages/a","/api/w/workspace-A/%30"+b.substring(1)+"/pages/a",prefix+"/pages/a#fragment",prefix+"/pages//a"))denied(()->NativeWorkspacePolicy.route(wire));
        for(String path:Arrays.asList("/api/w","/api/%77/workspace-A/"+b+"/session","/api/%2577/a/b/session"))yes(NativeWorkspacePolicy.namespace(path));
        for(String path:Arrays.asList("/api/w/a/short/session",prefix+"/",prefix+"/../session",prefix+"//session",prefix+"/%73ession",prefix+"/session/",prefix+"/account/session",prefix+"/organization/session",prefix+"/w/other/"+b+"/session","/api/%77/a/"+b+"/session"))denied(()->NativeWorkspacePolicy.route(path));
        yes(NativeAccountPolicy.namespace("/api/%2561ccount/session"));yes(!NativeAccountPolicy.namespace("/api/session"));
        for(String path:Arrays.asList("/api/account/session","/api/account/workspaces?session_binding="+b,"/api/account/workspaces?session_binding="+b+"&cursor=workspace-A"))yes(NativeAccountPolicy.path(path,"GET").equals(path));
        for(String path:Arrays.asList("/api/account/workspaces?session_binding="+b+"&session_binding="+b,"/api/account/workspaces?session_binding="+b+"&cursor=a%2Fb","/api/account/session?x=1","/api/account/workspaces/abc/open/","/api/account/%73ession"))denied(()->NativeAccountPolicy.path(path,"GET"));
        String suffix="; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800",token="abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
        yes(token.equals(NativeAccountPolicy.cookie(Collections.singletonMap("Set-Cookie",Collections.singletonList("fountain_account_session="+token+suffix)),"https://fountain.invalid")));
        for(String name:Arrays.asList("fountain_session","fountain_organization_session"))denied(()->NativeAccountPolicy.cookie(Collections.singletonMap("Set-Cookie",Collections.singletonList(name+"="+token+suffix)),"https://fountain.invalid"));
        String query="/api/organization/setup-eligibility?workspace_binding="+b+"&session_binding="+b+"&workspace_id=workspace-A";
        yes(NativeOrganizationPolicy.path(query,"GET").equals(query));
        denied(()->NativeOrganizationPolicy.path(query+"&workspace_id=other","GET"));
        yes(NativeWorkspacePolicy.networkUnreachable(new java.net.ConnectException()));yes(NativeWorkspacePolicy.networkUnreachable(new java.net.UnknownHostException()));
        yes(!NativeWorkspacePolicy.networkUnreachable(new java.net.SocketTimeoutException()));yes(!NativeWorkspacePolicy.networkUnreachable(new javax.net.ssl.SSLHandshakeException("test")));yes(!NativeWorkspacePolicy.networkUnreachable(new IllegalArgumentException("HTTP401")));
        System.out.println("PASS Android multiworkspace production policy "+checks+" checks");
    }
}
