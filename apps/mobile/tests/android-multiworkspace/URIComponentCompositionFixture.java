package dev.fountain.workspace;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.List;
/** Consume actual encodeURIComponent + production JS helper outputs. */
public final class URIComponentCompositionFixture {
 public static void main(String[] args)throws Exception {
  List<String> lines=Files.readAllLines(Paths.get(args[0]),StandardCharsets.UTF_8);
  if(lines.size()!=8)throw new AssertionError("Actual JS URI output count");
  for(String line:lines){String[] parts=line.split("\t",-1);if(parts.length!=2)throw new AssertionError("URI vector shape");
   NativeWorkspacePolicy.Route route=NativeWorkspacePolicy.route(parts[0]);
   if(!route.wire.equals(parts[0])||!route.logical.equals(parts[1]))throw new AssertionError("Original encoded path was rewritten");
   URI target=URI.create(NativePolicy.apiUrl("https://ehnovtfadpkwtubmwltl.supabase.co",route.wire));
   if(!target.getRawPath().equals("/functions/v1/fountain-api"+URI.create(parts[0]).getRawPath())||!target.getRawQuery().equals("cursor=literal%25&search=%3F%23"))throw new AssertionError("Target URI was decoded");
  }
  System.out.println("PASS actual JS encodeURIComponent/workspace wire to Java target URI composition: 8 checks");
 }
}
