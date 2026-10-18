package dev.fountain.workspace;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import java.util.List;
/** Real JS-produced URLs cross the production Java trust gate. */
public final class PublicationCompositionFixture {
 public static void main(String[] args)throws Exception {
  List<String> urls=Files.readAllLines(Paths.get(args[0]),StandardCharsets.UTF_8);
  if(urls.size()!=4)throw new AssertionError("Actual JS publication output count");
  NativePolicy.PublicWebTrust trust=new NativePolicy.PublicWebTrust();String backend="https://ehnovtfadpkwtubmwltl.supabase.co";
  trust.observe(backend,1,2,3,"https://family.example");
  for(String url:urls)if(!trust.allows(url,backend,1,2,3,true))throw new AssertionError("Production native URL denied by production Java boundary");
  if(trust.allows("https://family.example/api/w/workspace-A/0123456789abcdef0123456789abcdef/sites/family-site",backend,1,2,3,true))throw new AssertionError("Native parent wire path escaped into browser");
  System.out.println("PASS actual native JS preview/share to Java public-origin trust composition: 5 checks");
 }
}
