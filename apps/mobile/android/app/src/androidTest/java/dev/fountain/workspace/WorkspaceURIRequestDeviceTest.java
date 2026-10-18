package dev.fountain.workspace;
import static org.junit.Assert.*;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual Android URI/connection construction. No remote HTTP/Auth claim. */
@RunWith(AndroidJUnit4.class)
public class WorkspaceURIRequestDeviceTest {
 @Test public void canonicalResourceEncodingSurvivesAndroidConnectionConstruction()throws Exception {
  String prefix="/api/w/workspace-A/0123456789abcdef0123456789abcdef";
  for(String id:new String[]{"가족 文書?","tag#id","question?#","🏠","literal%41"}){
   String logical="/api/pages/"+OutboxPolicy.encode(id)+"/collaboration";
   NativeWorkspacePolicy.Route route=NativeWorkspacePolicy.route(prefix+logical.substring(4));
   String target=NativePolicy.apiUrl("https://ehnovtfadpkwtubmwltl.supabase.co",route.wire+"?cursor=literal%25&search=%3F%23");
   HttpsURLConnection connection=(HttpsURLConnection)new URL(target).openConnection();
   try {
    assertEquals(target,connection.getURL().toExternalForm());
    assertEquals("/functions/v1/fountain-api"+route.wire,Uri.parse(target).getEncodedPath());
    assertEquals("cursor=literal%25&search=%3F%23",Uri.parse(target).getEncodedQuery());
    String[] resource=OutboxPolicy.canonicalResource("GET",route.logical);
    assertNotNull(resource);assertEquals("page",resource[0]);assertEquals(id,resource[1]);
   }finally{connection.disconnect();}
  }
  for(String encoded:new String[]{"%70","%2F","%252F","%5C","%252e%252e","%C0%AF","%C2%80"})try{
   NativeWorkspacePolicy.route(prefix+"/pages/"+encoded+"/collaboration");fail("Noncanonical/dangerous segment accepted");
  }catch(IllegalArgumentException expected){}
 }
}
